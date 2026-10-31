/**
 * The gateway's script tools. Listing runs the native collection in a child
 * process, because collecting executes a test file's top-level code; reading
 * and saving touch one file. Every path resolves against one configured root,
 * symlink escapes included, and a save replaces the file atomically under a
 * save lock so a reader sees the old or the new version, never half of one.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/server';
import { ConfigurationError, errorMessage, InfrastructureError, isE2EError } from '../../internal/errors.ts';
import { textResult, type McpToolResult } from '../tools.ts';
import { childEnvironment, type ScriptMcpTool } from './config.ts';

/** Only test files the runner collects are addressable. */
const SCRIPT_EXTENSION = '.e2e.ts';

/** The per-file limit the specification sets. */
const MAX_SCRIPT_BYTES = 256 * 1024;

const MAX_PATH_CHARS = 512;
const MAX_TEXT_ARG_CHARS = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;
const COLLECT_TIMEOUT_MS = 30_000;
const COLLECT_STDOUT_BYTES = 8 * 1024 * 1024;

/** One test the collection found in a script. */
interface ListedScriptTest {
  readonly title: string;
  readonly target: string;
  readonly agent: string;
  readonly tags: readonly string[];
}

/** One script and the tests it declares. */
interface ListedScript {
  readonly path: string;
  readonly tests: readonly ListedScriptTest[];
}

interface ListScriptsResult {
  readonly scripts: readonly ListedScript[];
  /** Matches before `limit`; larger than `scripts.length` when truncated. */
  readonly total: number;
  readonly truncated: boolean;
}

interface GetScriptResult {
  readonly path: string;
  readonly content: string;
}

interface SaveScriptResult {
  readonly path: string;
  readonly bytes: number;
  readonly created: boolean;
}

/** What the gateway needs to serve the script tools. */
interface ScriptServiceOptions {
  readonly root: string;
  readonly configPath?: string | undefined;
  readonly cliEntry: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log: (line: string) => void;
}

const LIST_SCHEMA: Tool = {
  name: 'list_test_scripts',
  description:
    'List the test files in the configured test root that a run would collect, with the tests each declares. Runs collection in a child process; a test file that fails at import fails the call.',
  inputSchema: {
    type: 'object',
    properties: {
      prefix: { type: 'string', maxLength: MAX_TEXT_ARG_CHARS, description: 'Only files whose path under the test root starts with this.' },
      keyword: { type: 'string', maxLength: MAX_TEXT_ARG_CHARS, description: 'Only files whose path or a test title contains this, case-insensitive.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIST_LIMIT,
        description: `Most files to return (default ${DEFAULT_LIST_LIMIT}, at most ${MAX_LIST_LIMIT}).`,
      },
    },
    required: [],
    additionalProperties: false,
  },
  // Collection imports every test file's top-level code, which can write and
  // spawn; a host must not auto-approve it as a read.
  annotations: { readOnlyHint: false },
};

const GET_SCHEMA: Tool = {
  name: 'get_test_script',
  description: 'Read one test script under the configured test root.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', maxLength: MAX_PATH_CHARS, description: 'A path under the test root, relative or absolute.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const SAVE_SCHEMA: Tool = {
  name: 'save_test_script',
  description:
    'Atomically write one test script under the configured test root, creating missing parent directories. Refuses a path outside the root, a name not ending in .e2e.ts, and an existing file unless overwrite is true.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', maxLength: MAX_PATH_CHARS, description: 'A path under the test root, relative or absolute.' },
      content: { type: 'string', maxLength: MAX_SCRIPT_BYTES, description: 'The UTF-8 source, at most 256 KiB (bytes).' },
      overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
};

/** The three script tools, in the order a client lists them. */
export const SCRIPT_TOOL_DEFINITIONS: readonly Tool[] = [LIST_SCHEMA, GET_SCHEMA, SAVE_SCHEMA];

interface CollectedPair {
  readonly file: string;
  readonly title: string;
  readonly target: string;
  readonly agent: string;
  readonly tags: readonly string[];
}

interface CollectedSelection {
  readonly projectRoot: string;
  readonly pairs: readonly CollectedPair[];
}

interface ResolvedScript {
  readonly absolute: string;
  readonly relative: string;
}

/** Serves the script tools for one gateway; every MCP session shares it. */
export class ScriptService {
  /** Bumped by every save, so a collection that overlapped one is retried. */
  private epoch = 0;
  private saveChain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly options: ScriptServiceOptions,
  ) {}

  /** Resolves the root once, so a bad `--test-root` fails the server at startup. */
  static async create(options: ScriptServiceOptions): Promise<ScriptService> {
    let root: string;
    try {
      root = await realpath(options.root);
      if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    } catch (cause) {
      throw new ConfigurationError(
        'INVALID_ARGUMENT',
        `the test root ${JSON.stringify(options.root)} is not a readable directory: ${errorMessage(cause)}`,
      );
    }
    // The collection child runs with the test root as its working directory,
    // so anything it is given by path must not be resolved against ours.
    return new ScriptService(root, {
      ...options,
      configPath: options.configPath === undefined ? undefined : path.resolve(options.configPath),
      cliEntry: path.resolve(options.cliEntry),
    });
  }

  /** Runs one script tool; a thrown classified error becomes its error result. */
  async call(name: ScriptMcpTool, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult> {
    switch (name) {
      case 'list_test_scripts':
        return textResult(JSON.stringify(await this.listScripts(parseListArgs(args), signal), null, 2));
      case 'get_test_script':
        return textResult(JSON.stringify(await this.getScript(parseGetArgs(args)), null, 2));
      case 'save_test_script': {
        const input = parseSaveArgs(args);
        return textResult(JSON.stringify(await this.saveScript(input.path, input.content, input.overwrite), null, 2));
      }
    }
  }

  /** Collects the project in a child and groups the pairs by file. */
  async listScripts(input: { prefix?: string | undefined; keyword?: string | undefined; limit?: number | undefined }, signal: AbortSignal): Promise<ListScriptsResult> {
    const before = this.epoch;
    const { projectRoot, pairs } = await this.collect(signal);
    if (this.epoch !== before) {
      throw new InfrastructureError(
        'SCRIPT_CHANGED',
        'a test script was saved while the project was collected; call list_test_scripts again',
      );
    }
    const prefix = input.prefix === undefined ? undefined : normalizePrefix(input.prefix);
    const keyword = input.keyword?.toLowerCase();
    // One filesystem check per file, not per test.
    const paths = new Map<string, Promise<string | undefined>>();
    const listed = (file: string): Promise<string | undefined> => {
      let pending = paths.get(file);
      if (pending === undefined) {
        pending = this.listedPath(projectRoot, file);
        paths.set(file, pending);
      }
      return pending;
    };
    const byFile = new Map<string, ListedScriptTest[]>();
    for (const pair of pairs) {
      const file = await listed(pair.file);
      if (file === undefined) continue;
      if (prefix !== undefined && !file.startsWith(prefix)) continue;
      if (keyword !== undefined && !`${file}\n${pair.title}`.toLowerCase().includes(keyword)) continue;
      const tests = byFile.get(file) ?? [];
      tests.push({ title: pair.title, target: pair.target, agent: pair.agent, tags: pair.tags });
      byFile.set(file, tests);
    }
    const scripts = [...byFile.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([file, tests]) => ({ path: file, tests }));
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    return { scripts: scripts.slice(0, limit), total: scripts.length, truncated: scripts.length > limit };
  }

  /**
   * Maps a collected project-relative file to a path under the test root, or
   * undefined when the file is outside it or is a link. The collection always
   * imports the whole project; only files the client may read are listed.
   */
  private async listedPath(projectRoot: string, file: string): Promise<string | undefined> {
    const absolute = path.resolve(projectRoot, file);
    const info = await lstat(absolute).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink()) return undefined;
    const real = await realpath(absolute).catch(() => undefined);
    if (real === undefined || !inside(this.root, real)) return undefined;
    return relativeTo(this.root, real);
  }

  /** Reads one script, bounded by the per-file limit. */
  async getScript(input: string): Promise<GetScriptResult> {
    const target = await this.resolve(input);
    let info;
    try {
      info = await lstat(target.absolute);
    } catch (cause) {
      if (isMissing(cause)) throw new ConfigurationError('SCRIPT_NOT_FOUND', `${target.relative} does not exist`);
      throw scriptIo('get_test_script', cause);
    }
    if (!info.isFile()) throw invalid(`${target.relative} is not a file`);
    if (info.size > MAX_SCRIPT_BYTES) {
      throw invalid(`${target.relative} is ${info.size} bytes; the limit is ${MAX_SCRIPT_BYTES}`);
    }
    const content = await readFile(target.absolute, 'utf8').catch((cause: unknown) => {
      throw scriptIo('get_test_script', cause);
    });
    return { path: target.relative, content };
  }

  /** Writes one script through a temporary file in the same directory. */
  async saveScript(input: string, content: string, overwrite: boolean): Promise<SaveScriptResult> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_SCRIPT_BYTES) throw invalid(`save_test_script: content is ${bytes} bytes; the limit is ${MAX_SCRIPT_BYTES}`);
    // The lock is taken before the first await so two saves issued in one turn
    // queue in call order; resolving first would let the second jump ahead.
    return this.runSave(async () => {
      const target = await this.resolve(input, true);
      const existing = await lstat(target.absolute).catch((cause: unknown) => {
        if (isMissing(cause)) return undefined;
        throw scriptIo('save_test_script', cause);
      });
      if (existing?.isSymbolicLink() === true) throw policy(`save_test_script: ${target.relative} is a symbolic link`);
      if (existing !== undefined && !existing.isFile()) throw invalid(`save_test_script: ${target.relative} is not a file`);
      if (existing !== undefined && !overwrite) {
        throw new ConfigurationError(
          'SCRIPT_EXISTS',
          `save_test_script: ${target.relative} exists; pass overwrite: true to replace it`,
        );
      }
      const temporary = path.join(path.dirname(target.absolute), `.${path.basename(target.absolute)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, target.absolute);
      } catch (cause) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if (isE2EError(cause)) throw cause;
        throw scriptIo('save_test_script', cause);
      }
      this.epoch += 1;
      return { path: target.relative, bytes, created: existing === undefined };
    });
  }

  /**
   * Resolves a client path once: the parent, the root, and the real target.
   * A save creates missing parent directories; a read reports them missing.
   */
  private async resolve(input: string, createParents = false): Promise<ResolvedScript> {
    if (input.length === 0 || input.length > MAX_PATH_CHARS || hasControl(input)) {
      throw invalid('the path must be a non-empty path without control characters');
    }
    const basename = path.basename(input);
    if (!basename.endsWith(SCRIPT_EXTENSION) || basename.length === SCRIPT_EXTENSION.length) {
      throw invalid(`the path must name a ${SCRIPT_EXTENSION} file`);
    }
    const absolute = path.isAbsolute(input) ? path.normalize(input) : path.resolve(this.root, input);
    // Check the lexical path first: resolving it would let a client tell an
    // existing directory outside the root from a missing one.
    if (!inside(this.root, absolute)) throw policy(`${JSON.stringify(input)} is outside the test root`);
    let parent: string;
    try {
      parent = await realpath(path.dirname(absolute));
    } catch (cause) {
      if (!isMissing(cause)) throw scriptIo('resolve the path', cause);
      if (!createParents) throw new ConfigurationError('SCRIPT_NOT_FOUND', `the parent directory of ${JSON.stringify(input)} does not exist`);
      await this.createParentDirectories(input, absolute);
      parent = await realpath(path.dirname(absolute)).catch((failure: unknown) => {
        throw scriptIo('resolve the path', failure);
      });
    }
    // Only a link can move an in-root lexical path out; this is the check for it.
    if (!inside(this.root, parent)) throw policy(`${JSON.stringify(input)} resolves outside the test root`);
    const target = path.join(parent, basename);
    try {
      const real = await realpath(target);
      if (!inside(this.root, real)) throw policy(`${JSON.stringify(input)} resolves outside the test root`);
      if ((await lstat(target)).isSymbolicLink()) throw policy(`${JSON.stringify(input)} is a symbolic link`);
    } catch (cause) {
      if (isE2EError(cause)) throw cause;
      if (!isMissing(cause)) throw scriptIo('resolve the path', cause);
    }
    return { absolute: target, relative: relativeTo(this.root, target) };
  }

  /**
   * Creates a save path's missing directories, but only after the deepest
   * existing ancestor is proven to stay under the root. `mkdir` creates no
   * links itself, and the caller re-resolves the parent afterwards.
   */
  private async createParentDirectories(input: string, absolute: string): Promise<void> {
    let ancestor = path.dirname(absolute);
    for (;;) {
      try {
        const real = await realpath(ancestor);
        if (!inside(this.root, real)) throw policy(`${JSON.stringify(input)} resolves outside the test root`);
        break;
      } catch (cause) {
        if (isE2EError(cause)) throw cause;
        if (!isMissing(cause)) throw scriptIo('resolve the path', cause);
        const parent = path.dirname(ancestor);
        // The root exists, so the walk always stops there first.
        if (parent === ancestor) throw scriptIo('resolve the path', cause);
        ancestor = parent;
      }
    }
    try {
      await mkdir(path.dirname(absolute), { recursive: true, mode: 0o755 });
    } catch (cause) {
      throw scriptIo('save_test_script', cause);
    }
  }

  /** Collects through the built CLI, bounded in time and output. */
  private async collect(signal: AbortSignal): Promise<CollectedSelection> {
    const args = [this.options.cliEntry, 'list', '--reporter', 'json', '--pass-with-no-tests'];
    if (this.options.configPath !== undefined) args.push('--config', this.options.configPath);
    const outcome = await this.collectChild(args, signal);
    if (signal.aborted) throw new InfrastructureError('CANCELLED', 'list_test_scripts was cancelled');
    if (outcome.timedOut) throw new ConfigurationError('COLLECTION_ERROR', `list_test_scripts: collection did not finish within ${COLLECT_TIMEOUT_MS} ms`);
    if (outcome.overflow) throw new ConfigurationError('COLLECTION_ERROR', `list_test_scripts: collection output exceeded ${COLLECT_STDOUT_BYTES} bytes`);
    if (outcome.code !== 0) {
      // The child runs project code, which controls its stderr and can print a
      // secret there; the tool reports the exit instead of that text.
      throw new ConfigurationError('COLLECTION_ERROR', `list_test_scripts: collection failed (exit ${String(outcome.code)})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      throw new ConfigurationError('COLLECTION_ERROR', 'list_test_scripts: collection printed no valid JSON');
    }
    const result = parsed as { projectRoot?: unknown; pairs?: unknown } | null;
    const projectRoot = result?.projectRoot;
    if (typeof projectRoot !== 'string' || projectRoot === '') {
      throw new ConfigurationError('COLLECTION_ERROR', 'list_test_scripts: collection result has no project root');
    }
    const pairs = result?.pairs;
    if (!Array.isArray(pairs)) throw new ConfigurationError('COLLECTION_ERROR', 'list_test_scripts: collection result has no pairs');
    return {
      projectRoot: path.resolve(projectRoot),
      pairs: pairs.flatMap((pair): CollectedPair[] => {
        if (typeof pair !== 'object' || pair === null) return [];
        const { file, title, target, agent, tags } = pair as Record<string, unknown>;
        if (typeof file !== 'string' || typeof title !== 'string' || typeof target !== 'string') return [];
        return [
          {
            file,
            title,
            target,
            agent: typeof agent === 'string' ? agent : 'default',
            tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
          },
        ];
      }),
    };
  }

  /**
   * Spawns one collection child and waits for it. A timeout, an abort, or
   * output past the limit settles at once and kills the child: waiting for
   * `close` would hang while a grandchild the collected code spawned keeps the
   * inherited stdio pipes open, which would pin the session's in-flight count
   * forever.
   */
  private collectChild(args: readonly string[], signal: AbortSignal): Promise<CollectOutcome> {
    return new Promise<CollectOutcome>((resolve, reject) => {
      const child = spawn(process.execPath, [...args], {
        cwd: this.root,
        env: childEnvironment(this.options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const pieces: Buffer[] = [];
      let stdoutBytes = 0;
      let timedOut = false;
      let overflow = false;
      let settled = false;
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
        this.options.log(`collection child exited (${String(code)})`);
        resolve({
          code,
          timedOut,
          overflow,
          stdout: Buffer.concat(pieces).toString('utf8'),
        });
      };
      const stop = (): void => {
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
        finish(null);
      }, COLLECT_TIMEOUT_MS);
      const onAbort = (): void => {
        stop();
        finish(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // An abort that landed before the listener existed would otherwise
      // leave the child running to its timeout.
      if (signal.aborted) onAbort();
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > COLLECT_STDOUT_BYTES) {
          overflow = true;
          stop();
          finish(null);
          return;
        }
        pieces.push(chunk);
      });
      // Drain it so project code never blocks on a full pipe; its content is
      // project-controlled and is never returned.
      child.stderr.on('data', () => undefined);
      child.once('error', (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(scriptIo('start collection', cause));
      });
      child.once('close', (code) => finish(code));
    });
  }

  /**
   * Serializes saves. One chain, not one per path: two spellings of a file
   * (case on Windows, an in-root directory link) would key differently, and
   * saves are small and rare enough that a global order costs nothing.
   */
  private runSave<T>(action: () => Promise<T>): Promise<T> {
    const next = this.saveChain.then(action, action);
    this.saveChain = next.catch(() => undefined);
    return next;
  }
}

interface CollectOutcome {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly overflow: boolean;
  readonly stdout: string;
}

function parseListArgs(args: Record<string, unknown>): { prefix?: string | undefined; keyword?: string | undefined; limit?: number | undefined } {
  objectArgs('list_test_scripts', args, ['prefix', 'keyword', 'limit']);
  const prefix = optionalText('list_test_scripts', args, 'prefix');
  const keyword = optionalText('list_test_scripts', args, 'keyword');
  const limit = args['limit'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
    throw invalid(`list_test_scripts: limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  return {
    ...(prefix === undefined ? {} : { prefix }),
    ...(keyword === undefined ? {} : { keyword }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parseGetArgs(args: Record<string, unknown>): string {
  objectArgs('get_test_script', args, ['path']);
  return textArg('get_test_script', args, 'path');
}

function parseSaveArgs(args: Record<string, unknown>): { path: string; content: string; overwrite: boolean } {
  objectArgs('save_test_script', args, ['path', 'content', 'overwrite']);
  const scriptPath = textArg('save_test_script', args, 'path');
  const content = args['content'];
  if (typeof content !== 'string') throw invalid('save_test_script: content must be a string');
  if (Buffer.byteLength(content, 'utf8') > MAX_SCRIPT_BYTES) {
    throw invalid(`save_test_script: content is larger than ${MAX_SCRIPT_BYTES} bytes`);
  }
  const overwrite = args['overwrite'] ?? false;
  if (typeof overwrite !== 'boolean') throw invalid('save_test_script: overwrite must be a boolean');
  return { path: scriptPath, content, overwrite };
}

function objectArgs(name: string, args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw invalid(`${name}: unknown argument ${JSON.stringify(key)}`);
  }
}

function textArg(name: string, args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw invalid(`${name}: ${key} must be a string`);
  if (value.length === 0 || value.length > MAX_PATH_CHARS || hasControl(value)) {
    throw invalid(`${name}: ${key} must be a non-empty string without control characters`);
  }
  return value;
}

function optionalText(name: string, args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT_ARG_CHARS || hasControl(value)) {
    throw invalid(`${name}: ${key} must be a string of at most ${MAX_TEXT_ARG_CHARS} characters`);
  }
  return value;
}

/** Control characters never belong in a path or a search term, and a log line. */
function hasControl(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) < 0x20) return true;
  }
  return false;
}

function normalizePrefix(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** Whether `candidate` is `root` or sits under it. */
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function relativeTo(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT';
}

function invalid(message: string): ConfigurationError {
  return new ConfigurationError('INVALID_ARGUMENT', message);
}

function policy(message: string): ConfigurationError {
  return new ConfigurationError('POLICY_DENIED', message);
}

function scriptIo(action: string, cause: unknown): InfrastructureError {
  return new InfrastructureError('SCRIPT_IO_FAILED', `${action}: ${errorMessage(cause)}`, { cause });
}
