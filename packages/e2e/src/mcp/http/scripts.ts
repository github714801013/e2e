/**
 * The gateway's script tools. Listing runs the native collection in a child
 * process, because collecting executes a test file's top-level code; reading
 * and saving touch one file. Every path resolves against one configured root,
 * symlink escapes included, and a save replaces the file atomically under a
 * save lock so a reader sees the old or the new version, never half of one.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigurationError, errorMessage, InfrastructureError, isE2EError } from '@e2e-dev/core/lib/internal/errors';
import { discoverFiles } from '@e2e-dev/core/lib/internal/globs';
import type { Tool } from '@modelcontextprotocol/server';
import { textResult, type McpToolResult } from '../tools.ts';
import type { AccountStore } from './accounts.ts';
import { childEnvironment, type ScriptMcpTool } from './config.ts';

/** Only test files the runner collects are addressable. */
const SCRIPT_EXTENSION = '.e2e.ts';

/** The per-file limit the specification sets. */
const MAX_SCRIPT_BYTES = 256 * 1024;

/** A candidate a save left behind: `<name>.<uuid>.tmp.e2e.ts`. */
const CANDIDATE_NAME = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp\.e2e\.ts$/u;

const MAX_PATH_CHARS = 512;
const MAX_TEXT_ARG_CHARS = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;
const COLLECT_TIMEOUT_MS = 60_000;
const COLLECT_STDOUT_BYTES = 8 * 1024 * 1024;
/** Files the text scan hands to collection, best first. */
const CANDIDATE_LIMIT = 100;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

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

/** A configured target and the app address a caller picks it by. */
interface ListedTargetApp {
  readonly name: string;
  readonly url?: string;
  /** Present only for an account pool entry; a base target has no business description. */
  readonly description?: string;
  /** Present only for an account pool entry; a disabled one is visible but not selectable. */
  readonly enabled?: boolean;
}

interface ListScriptsResult {
  readonly scripts: readonly ListedScript[];
  /** Test files a query token occurs in; larger than `scripts.length` when truncated. */
  readonly total: number;
  readonly truncated: boolean;
  /** Files the collection could not read, as paths under the test root. */
  readonly uncollected: readonly string[];
  /** Every configured target with its app URL, for picking one by page address; no credentials. */
  readonly targets: readonly ListedTargetApp[];
}

/** One test file the text scan read, with its raw occurrence count and whether it may declare a setup test. */
interface ScannedFile {
  readonly absolute: string;
  readonly relative: string;
  readonly hits: number;
  readonly setup: boolean;
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
  /** The account pool whose entries are merged into the target list. */
  readonly accounts?: AccountStore | undefined;
  readonly log: (line: string) => void;
}

const LIST_SCHEMA: Tool = {
  name: 'list_test_scripts',
  description:
    'Search the test files in the configured test root that a run would collect: a text scan picks the files whose source contains keyword, only those are collected in a child process, and they come back ordered by BM25 relevance (test titles and tags rank above path). A file whose collection fails is left out and named under uncollected instead of failing the call. total counts the files the scan matched before the candidate cap. The result also lists every configured target with its app URL, plus every account pool entry with its description and enabled flag, so a caller can pick a target by page address or an account by what it is for; credentials never appear in it. Without a keyword the call is refused.',
  inputSchema: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        maxLength: MAX_TEXT_ARG_CHARS,
        description: 'Only files whose path under the test root starts with this literal prefix; the scan and collection narrow to them.',
      },
      keyword: {
        type: 'string',
        maxLength: MAX_TEXT_ARG_CHARS,
        description: 'Required. A search term matched against each file\'s source and ranked with BM25; ASCII words and Chinese character bigrams are matched.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIST_LIMIT,
        description: `Most files to return (default ${DEFAULT_LIST_LIMIT}, at most ${MAX_LIST_LIMIT}).`,
      },
    },
    required: ['keyword'],
    additionalProperties: false,
  },
  // Collection imports test files' top-level code, which can write and
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
    'Atomically write one test script under the configured test root, creating missing parent directories. The candidate is collected first, which runs its top-level code, and content the runner cannot collect is refused. Also refuses a path outside the root, a name not ending in .e2e.ts, and an existing file unless overwrite is true; a refusal leaves the existing file untouched.',
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
  /** Project-relative files collection failed to read. */
  readonly uncollected: readonly string[];
  readonly targets: readonly ListedTargetApp[];
}

interface ResolvedScript {
  readonly absolute: string;
  readonly relative: string;
}

/** Serves the script tools for one gateway; every MCP session shares it. */
export class ScriptService {
  private saveChain: Promise<unknown> = Promise.resolve();
  /** One collection at a time, a save's validation child included. */
  private collectChain: Promise<unknown> = Promise.resolve();

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
    // A candidate a killed save left behind is discovered and imported by
    // every later collection, which is the failure this service prevents.
    await sweepCandidates(root);
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
        return textResult(JSON.stringify(await this.listScripts(parseListArgs(args), signal)));
      case 'get_test_script':
        return textResult(JSON.stringify(await this.getScript(parseGetArgs(args))));
      case 'save_test_script': {
        const input = parseSaveArgs(args);
        return textResult(JSON.stringify(await this.saveScript(input.path, input.content, input.overwrite, signal)));
      }
    }
  }

  /**
   * Scans the test tree for the keyword, collects only the best candidates
   * (and every file that may declare a setup test), then ranks their tests
   * with BM25. A search that matches no file returns empty without starting a
   * collection child.
   */
  async listScripts(input: { prefix?: string | undefined; keyword: string; limit?: number | undefined }, signal: AbortSignal): Promise<ListScriptsResult> {
    const prefix = input.prefix === undefined ? undefined : normalizePrefix(input.prefix);
    const tokens = queryTokens(input.keyword);
    // The lock covers the scan and the collection: a save's candidate lives in
    // the tree until it is validated, so neither may see it.
    const { projectRoot, pairs, uncollected: failedFiles, targets, matched } = await this.withCollectionLock(async () => {
      const scanned = await this.scanTestFiles(prefix, tokens);
      const hits = scanned.filter((file) => file.hits > 0);
      if (hits.length === 0) return { projectRoot: this.root, pairs: [], uncollected: [], targets: [], matched: hits };
      const candidates = hits
        .toSorted((left, right) => right.hits - left.hits || comparePaths(left.relative, right.relative))
        .slice(0, CANDIDATE_LIMIT);
      // A setup test the selection needs can live in a file no candidate
      // matched, so every file that may declare one is imported as well.
      const named = new Map<string, ScannedFile>();
      for (const setup of scanned.filter((entry) => entry.setup)) named.set(setup.absolute, setup);
      for (const candidate of candidates) named.set(candidate.absolute, candidate);
      const collected = await this.collect(signal, [...named.values()].map((entry) => entry.absolute), true);
      return { ...collected, matched: hits };
    });
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
    const candidates = new Set(matched.map((file) => file.relative));
    const byFile = new Map<string, ListedScriptTest[]>();
    for (const pair of pairs) {
      const file = await listed(pair.file);
      if (file === undefined || !candidates.has(file)) continue;
      const tests = byFile.get(file) ?? [];
      tests.push({ title: pair.title, target: pair.target, agent: pair.agent, tags: pair.tags });
      byFile.set(file, tests);
    }
    // A file the scan matched but the collection could not run is not listed.
    const scripts = rankScripts(
      [...byFile.entries()].map(([file, tests]) => ({ path: file, tests })),
      tokens,
    );
    const uncollected: string[] = [];
    for (const file of failedFiles) {
      const relative = await listed(file);
      if (relative === undefined) continue;
      if (prefix !== undefined && !relative.startsWith(prefix)) continue;
      uncollected.push(relative);
    }
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    return {
      scripts: scripts.slice(0, limit),
      total: matched.length,
      truncated: matched.length > Math.min(scripts.length, limit),
      uncollected,
      targets: await this.mergedTargets(targets),
    };
  }

  /**
   * Reads every test file under the prefix and records where a query token
   * occurs and whether the file may declare a setup test. The project config
   * is not read, so this is a superset of what a run collects; the collection
   * drops the rest. A prefix that names a directory scans only it; any other
   * prefix filters the whole tree, so a file path still works.
   */
  private async scanTestFiles(prefix: string | undefined, tokens: readonly string[]): Promise<ScannedFile[]> {
    if (tokens.length === 0) return [];
    const named = prefix === undefined || prefix === '' ? undefined : prefix;
    const start = named === undefined ? this.root : path.resolve(this.root, named);
    if (!inside(this.root, start)) {
      throw policy(`list_test_scripts: prefix ${JSON.stringify(named)} is outside the test root`);
    }
    const isDirectory = await stat(start).then((info) => info.isDirectory()).catch(() => false);
    if (isDirectory) {
      // A link inside the root can point out of it, and only a resolved path
      // proves where the scan reads.
      const real = await realpath(start).catch(() => undefined);
      if (real === undefined || !inside(this.root, real)) {
        throw policy(`list_test_scripts: prefix ${JSON.stringify(named)} resolves outside the test root`);
      }
    }
    const scanRoot = isDirectory ? start : this.root;
    const files = discoverFiles(scanRoot, ['**/*.e2e.ts', '**/*.e2e.tsx']);
    const scanned: ScannedFile[] = [];
    // Reads overlap: one at a time spends most of a large tree waiting.
    const next = { index: 0 };
    const workers = Array.from({ length: Math.min(32, files.length) }, async () => {
      for (;;) {
        const file = files[next.index];
        next.index += 1;
        if (file === undefined) return;
        const absolute = path.join(scanRoot, file);
        const relative = relativeTo(this.root, absolute);
        if (named !== undefined && !relative.startsWith(named)) continue;
        let content: string;
        try {
          content = await readFile(absolute, 'utf8');
        } catch {
          continue;
        }
        const hits = countOccurrences(content, tokens);
        scanned.push({ absolute, relative, hits, setup: content.includes('test.setup(') });
      }
    });
    await Promise.all(workers);
    return scanned;
  }

  /**
   * The collected targets followed by the account pool's. A project whose
   * config reads `E2E_TARGETS_FILE` reports the pool entries among its
   * collected targets too; they are replaced by the pool's own view so a
   * description is never lost. The pool is read on every call, so an admin
   * change applies to the next list without a restart.
   */
  private async mergedTargets(base: readonly ListedTargetApp[]): Promise<readonly ListedTargetApp[]> {
    if (this.options.accounts === undefined) return base;
    const pool = await this.options.accounts.list();
    const accountNames = new Set(pool.map((account) => account.name));
    const declared = base.filter((target) => !accountNames.has(target.name));
    const accounts = pool.map((account): ListedTargetApp => ({
      name: account.name,
      url: account.url,
      description: account.description,
      enabled: account.enabled,
    }));
    return [...declared, ...accounts];
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

  /**
   * Writes one script through a temporary file in the same directory, after
   * proving the file collects: one save that cannot import would otherwise
   * fail every later `list_test_scripts` for the whole project.
   */
  async saveScript(input: string, content: string, overwrite: boolean, signal?: AbortSignal): Promise<SaveScriptResult> {
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
      // The candidate must keep the .e2e.ts extension to be collectable, and a
      // dot-prefixed name is skipped by discovery even when named explicitly.
      // shortcut: a collection outside this service (a run_test job or a hand
      // run) can import the candidate for the validation window; coordinate
      // across processes only if saves and runs start to overlap in practice.
      const temporary = path.join(path.dirname(target.absolute), `${path.basename(target.absolute)}.${randomUUID()}.tmp${SCRIPT_EXTENSION}`);
      try {
        await this.withCollectionLock(async () => {
          await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          await this.validateCandidate(temporary, target.relative, signal);
          await rename(temporary, target.absolute);
        });
      } catch (cause) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if (isE2EError(cause)) throw cause;
        throw scriptIo('save_test_script', cause);
      }
      return { path: target.relative, bytes, created: existing === undefined };
    });
  }

  /**
   * Collects the project with the candidate selected. The candidate lives in
   * the target's directory, so relative imports resolve as they will after
   * the rename; an import failure in an unselected file is tolerated by the
   * collection itself. The child's stderr is project output and is never
   * returned; the error names the file and exit.
   */
  private async validateCandidate(temporary: string, relative: string, signal: AbortSignal | undefined): Promise<void> {
    const outcome = await this.collectChild(this.collectArgs([temporary]), signal);
    if (signal?.aborted === true) throw new InfrastructureError('CANCELLED', 'save_test_script was cancelled');
    if (outcome.timedOut || outcome.overflow || outcome.code !== 0) {
      const reason = outcome.timedOut
        ? `no result within ${COLLECT_TIMEOUT_MS} ms`
        : outcome.overflow
          ? `output over ${COLLECT_STDOUT_BYTES} bytes`
          : `exit ${String(outcome.code)}`;
      throw new ConfigurationError(
        'COLLECTION_ERROR',
        `save_test_script: ${relative} does not collect (${reason}); the file was not saved`,
      );
    }
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

  /**
   * The collection command; positionals narrow it to named files. A candidate
   * validation never allows an uncollected file, since the save must be
   * refused.
   */
  private collectArgs(positionals?: readonly string[], allowUncollected = false, importsNamed = false): string[] {
    const args = [this.options.cliEntry, 'list', '--reporter', 'json', '--pass-with-no-tests'];
    if (this.options.configPath !== undefined) args.push('--config', this.options.configPath);
    if (allowUncollected) args.push('--allow-uncollected');
    if (importsNamed) args.push('--imports-named');
    if (positionals !== undefined) args.push(...positionals);
    return args;
  }

  /** Collects through the built CLI, bounded in time and output. */
  private async collect(signal: AbortSignal, positionals?: readonly string[], importsNamed = false): Promise<CollectedSelection> {
    let outcome = await this.collectChild(this.collectArgs(positionals, true, importsNamed), signal);
    // A listing that imported only its named files can miss the setup test a
    // selected test's session needs; the full collection finds it.
    if (importsNamed && !outcome.timedOut && !outcome.overflow && outcome.code !== 0 && !signal.aborted) {
      outcome = await this.collectChild(this.collectArgs(positionals, true), signal);
    }
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
    const result = parsed as { projectRoot?: unknown; pairs?: unknown; targets?: unknown; uncollected?: unknown } | null;
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
      // The reason stays out of the tool result: collection errors can quote
      // the failed source, and the path is what a caller acts on.
      uncollected: Array.isArray(result?.uncollected)
        ? result.uncollected.flatMap((entry): string[] => {
            if (typeof entry !== 'object' || entry === null) return [];
            const { file } = entry as Record<string, unknown>;
            return typeof file === 'string' ? [file] : [];
          })
        : [],
      targets: Array.isArray(result?.targets)
        ? result.targets.flatMap((entry): ListedTargetApp[] => {
            if (typeof entry !== 'object' || entry === null) return [];
            const { name, url } = entry as Record<string, unknown>;
            if (typeof name !== 'string') return [];
            return [typeof url === 'string' ? { name, url } : { name }];
          })
        : [],
    };
  }

  /**
   * Spawns one collection child and waits for it. A timeout, an abort, or
   * output past the limit settles at once and kills the child: waiting for
   * `close` would hang while a grandchild the collected code spawned keeps the
   * inherited stdio pipes open, which would pin the session's in-flight count
   * forever.
   */
  private async collectChild(args: readonly string[], signal: AbortSignal | undefined): Promise<CollectOutcome> {
    // A project whose config declares its targets from `E2E_TARGETS_FILE` needs
    // the pool's generated view here too, or collection sees no targets at all.
    const pool = await this.options.accounts?.childEnvironment();
    const env = pool === undefined ? childEnvironment(this.options.env) : { ...childEnvironment(this.options.env), ...pool };
    return new Promise<CollectOutcome>((resolve, reject) => {
      const child = spawn(process.execPath, [...args], {
        cwd: this.root,
        env,
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
        signal?.removeEventListener('abort', onAbort);
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
      signal?.addEventListener('abort', onAbort, { once: true });
      // An abort that landed before the listener existed would otherwise
      // leave the child running to its timeout.
      if (signal?.aborted === true) onAbort();
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
        signal?.removeEventListener('abort', onAbort);
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

  /**
   * Serializes the write-validate-rename window of a save with every listing:
   * a candidate lives inside the test root until it is validated, so no
   * listing may collect the project while it is there, and no save may add
   * one while a listing collects.
   */
  private withCollectionLock<T>(action: () => Promise<T>): Promise<T> {
    const next = this.collectChain.then(action, action);
    this.collectChain = next.catch(() => undefined);
    return next;
  }
}

/**
 * Deletes candidates a killed save left behind. One is a complete .e2e.ts
 * file in the tree, so every later collection would import it.
 */
async function sweepCandidates(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return;
  for (const entry of entries) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) await sweepCandidates(item);
    } else if (entry.isFile() && CANDIDATE_NAME.test(entry.name)) {
      await rm(item, { force: true }).catch(() => undefined);
    }
  }
}

interface CollectOutcome {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly overflow: boolean;
  readonly stdout: string;
}

function parseListArgs(args: Record<string, unknown>): { prefix?: string | undefined; keyword: string; limit?: number | undefined } {
  objectArgs('list_test_scripts', args, ['prefix', 'keyword', 'limit']);
  const prefix = optionalText('list_test_scripts', args, 'prefix');
  const keyword = args['keyword'];
  if (
    typeof keyword !== 'string' ||
    keyword.length === 0 ||
    keyword.length > MAX_TEXT_ARG_CHARS ||
    hasControl(keyword) ||
    keyword.trim().length === 0
  ) {
    throw invalid(`list_test_scripts: keyword is required and must be a non-empty search term of at most ${MAX_TEXT_ARG_CHARS} characters`);
  }
  const limit = args['limit'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)) {
    throw invalid(`list_test_scripts: limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
  }
  return {
    ...(prefix === undefined ? {} : { prefix }),
    keyword,
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

/** The query split into lowercase ASCII words and CJK bigrams, deduplicated. */
function queryTokens(query: string): string[] {
  return [...new Set(tokenize(query))];
}

/** Lowercase ASCII words and CJK bigrams; a one-character CJK run stays whole. */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = lower.match(/[a-z0-9]+/gu) ?? [];
  for (const run of lower.match(/[㐀-䶿一-鿿豈-﫿]+/gu) ?? []) {
    const characters = [...run];
    if (characters.length === 1) tokens.push(run);
    else for (let index = 0; index + 1 < characters.length; index += 1) tokens.push(characters[index]! + characters[index + 1]!);
  }
  return tokens;
}

/** How many times any of the tokens occurs in the text, ASCII tokens case-insensitively. */
function countOccurrences(text: string, tokens: readonly string[]): number {
  let lower: string | undefined;
  let total = 0;
  for (const token of tokens) {
    // A CJK token has no case, so a Chinese search never copies the file.
    const haystack = /^[a-z0-9]+$/u.test(token) ? (lower ??= text.toLowerCase()) : text;
    for (let index = haystack.indexOf(token); index !== -1; index = haystack.indexOf(token, index + token.length)) total += 1;
  }
  return total;
}

/**
 * Orders the collected scripts by BM25 relevance: path counts once, a test
 * title three times, a tag twice. Equal scores keep the path order.
 */
function rankScripts(scripts: readonly ListedScript[], tokens: readonly string[]): ListedScript[] {
  if (scripts.length === 0) return [];
  const docs = scripts.map((script) => {
    const frequencies = new Map<string, number>();
    const add = (text: string, weight: number): void => {
      for (const token of tokenize(text)) frequencies.set(token, (frequencies.get(token) ?? 0) + weight);
    };
    add(script.path, 1);
    for (const test of script.tests) {
      add(test.title, 3);
      for (const tag of test.tags) add(tag, 2);
    }
    let length = 0;
    for (const count of frequencies.values()) length += count;
    return { script, frequencies, length };
  });
  const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const token of doc.frequencies.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  return docs
    .map((doc) => {
      let score = 0;
      for (const token of tokens) {
        const frequency = doc.frequencies.get(token);
        if (frequency === undefined) continue;
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
        const norm = averageLength === 0 ? 1 : averageLength;
        score += (idf * frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / norm));
      }
      return { script: doc.script, score };
    })
    .toSorted((left, right) => right.score - left.score || comparePaths(left.script.path, right.script.path))
    .map((entry) => entry.script);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
