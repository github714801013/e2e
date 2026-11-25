/** Synchronous registration during module evaluation. */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCaseBrand } from '@e2e-dev/core/lib/internal/brands';
import { describeValue } from '@e2e-dev/core/lib/config/validate';
import { isRecordingMode, legacyTraceSpelling, RECORDING_MODES } from '@e2e-dev/core/lib/internal/recording-modes';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import { MAX_TIMER_MS } from '@e2e-dev/core/lib/internal/time';
import { validateTitle } from '@e2e-dev/core/lib/internal/ids';
import { realmSlot } from '@e2e-dev/core/lib/internal/realm-slot';
import { markRunningTestExpectedToFail } from '@e2e-dev/core/lib/internal/expected-failure';
import { parseModifierCall, skipRunningTest } from '../internal/skip.ts';
import { formatEachTitle, readRows } from './each.ts';
import { unknownKeyMessage } from '@e2e-dev/core/lib/internal/options';
import type { SourceLocation } from '@e2e-dev/core/lib/internal/source';
import { fixtureNames, type FixtureUserFn } from './fixture-names.ts';
import { checkDeclaredFixtures, describeFixture, describeUser } from './fixture-plan.ts';
import type {
  DescribeOptions,
  EachFn,
  EachRegistrar,
  FixtureFn,
  FixtureScope,
  SetupOptions,
  TestAPI,
  TestCase,
  TestHookFn,
  TestOptions,
  TestRegistrar,
} from '@e2e-dev/core/lib/types';

export interface GroupNode {
  readonly title: string;
  readonly options: DescribeOptions;
  readonly parent: GroupNode | undefined;
  readonly serial: boolean;
}

export type TestMode = 'normal' | 'skip' | 'only';

/**
 * A registered test or hook body. `TestAPI` types what each receives; at run
 * time it gets the object its attempt or suite hook binds (`bindFixtures`).
 */
export type TestBody = TestHookFn<object>;

/**
 * One fixture a `test.extend()` call defined: its name, its setup/teardown
 * function, and how long one instance lives. The object is the fixture's
 * identity: a worker keeps one instance per definition. The fixtures it
 * depends on are the ones its function names (`fixtureNames`). One named
 * like a built-in fixture, or like an earlier fixture of its chain, extends
 * it: inside its function its own name is the fixture it extends.
 */
export interface FixtureDefinition {
  readonly name: string;
  readonly fn: FixtureFn<object, unknown>;
  /** The fixtures `fn` names in its first parameter: what it depends on. */
  readonly names: readonly string[];
  /**
   * The scope it declares. A plain function declares none: it has the scope
   * of the fixture it extends, and is a test fixture when it extends none.
   */
  readonly scope: FixtureScope | undefined;
  /**
   * Whether it declares itself set up for every test (or once per worker)
   * whether or not anything names it. One that does not say has the `auto`
   * of the fixture it extends, and is set up on demand when it extends none.
   */
  readonly auto: boolean | undefined;
  /**
   * Which `test.extend()` call of its chain defined it, counted from 0. A
   * fixture sees the fixtures of its own call and of the ones before it.
   */
  readonly layer: number;
  /** Where its `test.extend()` call is. */
  readonly source?: SourceLocation | undefined;
}

export interface RegisteredTest {
  readonly kind: 'test' | 'setup';
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly declarationIndex: number;
  readonly options: TestOptions;
  readonly sessions: readonly string[];
  /** The tags the test declares: its describe chain's, outermost first, then its own, each once. */
  readonly tags: readonly string[];
  /** The body, called with the fixtures it names; its `test` typed what those are. */
  readonly fn: TestBody;
  /** The fixtures `fn` names in its first parameter: the ones its attempt sets up for it. */
  readonly names: readonly string[];
  /** The `test.extend()` chain the test was registered through, outermost definition first. */
  readonly fixtures: readonly FixtureDefinition[];
  readonly group: GroupNode | undefined;
  readonly mode: TestMode;
  readonly source: SourceLocation | undefined;
}

interface HookBase {
  readonly group: GroupNode | undefined;
  readonly declarationIndex: number;
  readonly fn: TestBody;
  /** The fixtures `fn` names in its first parameter. */
  readonly names: readonly string[];
  /** The `test.extend()` chain the hook was registered through. */
  readonly fixtures: readonly FixtureDefinition[];
  /** Where the hook was registered. */
  readonly source?: SourceLocation | undefined;
}

/**
 * A per-test hook: runs with the attempt's fixtures. At run time the hook
 * receives the test's fixture object, which the test's own chain shapes.
 */
export interface TestHook extends HookBase {
  readonly kind: 'beforeEach' | 'afterEach';
}

/**
 * A suite hook: runs once per scope instance with worker fixtures only, the
 * built-in ones and the worker fixtures of the chain it was registered through.
 */
export interface SuiteHook extends HookBase {
  readonly kind: 'beforeAll' | 'afterAll';
}

export type RegisteredHook = TestHook | SuiteHook;
type HookDeclaration = Pick<RegisteredHook, 'kind' | 'fn' | 'fixtures'>;

export interface ModuleRegistration {
  readonly tests: readonly RegisteredTest[];
  readonly hooks: readonly RegisteredHook[];
}

const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

class Collector {
  readonly tests: RegisteredTest[] = [];
  readonly hooks: RegisteredHook[] = [];
  private currentGroup: GroupNode | undefined = undefined;
  private declarationCounter = 0;
  private closed = false;
  /** Real path of the module being collected, the file a test's source prefers. */
  private readonly moduleFile: string | undefined;

  constructor(
    moduleFile: string | undefined,
    /** Rewrites a registered secret value in a title to its marker. */
    private readonly redactTitle: (title: string) => string,
  ) {
    this.moduleFile = moduleFile === undefined ? undefined : realPath(moduleFile);
  }

  close(): ModuleRegistration {
    this.closed = true;
    return { tests: this.tests, hooks: this.hooks };
  }

  /**
   * The title as it registers: validated as written, redacted, then
   * normalized to NFC, and validated again, since a marker can be longer
   * than the value it replaces.
   */
  private title(raw: string): string {
    const rawError = validateTitle(raw);
    if (rawError !== null) throw new CollectionError(rawError);
    const title = this.redactTitle(raw).normalize('NFC');
    const error = title === raw.normalize('NFC') ? null : validateTitle(title);
    if (error !== null) throw new CollectionError(`${error} once secret values are redacted`);
    return title;
  }

  private assertOpen(api: string): void {
    if (this.closed) {
      throw new CollectionError(
        `${api} was called after module evaluation finished; registration must be synchronous`,
      );
    }
  }

  /** Whether registration is inside a serial group, at any depth. */
  get inSerialGroup(): boolean {
    return insideSerial(this.currentGroup);
  }

  /**
   * Registers one test. Its fixtures are the ones `fn` names in its first
   * parameter, unless `namedBy` says which function and parameter name them:
   * a `test.each` row runs a wrapper, and the body it wraps takes the
   * fixtures after the row.
   */
  registerTest(
    kind: 'test' | 'setup',
    mode: TestMode,
    title: string,
    options: TestOptions,
    sessions: readonly string[],
    fn: TestBody,
    fixtures: readonly FixtureDefinition[],
    namedBy?: { readonly fn: FixtureUserFn; readonly position: number },
  ): TestCase {
    this.assertOpen(kind === 'setup' ? 'test.setup()' : 'test()');
    const normalizedTitle = this.title(title);
    if (typeof fn !== 'function') throw new CollectionError('test body must be a function');
    if (kind === 'setup') {
      if (this.currentGroup !== undefined) {
        throw new CollectionError('setup tests must be top-level; they cannot appear in describe');
      }
      if (sessions.length === 0) {
        throw new CollectionError('setup tests must declare at least one session');
      }
      if (Array.isArray(options.agent)) {
        throw new CollectionError(
          'a setup test runs once per target and pins at most one agent; agent must be a single name',
        );
      }
      for (const name of sessions) {
        if (!SESSION_NAME_PATTERN.test(name)) {
          throw new CollectionError(
            `invalid session name ${JSON.stringify(name)}: names are 1 through 128 ASCII letters, numbers, "_", "-", or "."`,
          );
        }
      }
      if (new Set(sessions).size !== sessions.length) {
        throw new CollectionError('duplicate session names in one setup declaration');
      }
    }
    validateTestOptions(options, this.currentGroup, kind);
    const titlePath = [...groupTitles(this.currentGroup), normalizedTitle];
    const source = captureSource(this.moduleFile);
    const registered: RegisteredTest = {
      kind,
      title: normalizedTitle,
      titlePath,
      declarationIndex: this.declarationCounter,
      options,
      sessions,
      tags: declaredTags(this.currentGroup, options),
      fn,
      names: fixtureNames(namedBy?.fn ?? fn, describeUser({ kind, titlePath }), source, namedBy?.position),
      fixtures,
      group: this.currentGroup,
      mode,
      source,
    };
    this.declarationCounter += 1;
    this.tests.push(registered);
    return Object.freeze({ [testCaseBrand]: true as const });
  }

  registerDescribe(title: string, options: DescribeOptions, body: () => unknown): void {
    this.assertOpen('describe()');
    const normalizedTitle = this.title(title);
    if (typeof body !== 'function') throw new CollectionError('describe body must be a function');
    validateDescribeOptions(options, this.currentGroup);
    const group: GroupNode = {
      title: normalizedTitle,
      options,
      parent: this.currentGroup,
      serial: options.serial === true,
    };
    const previous = this.currentGroup;
    this.currentGroup = group;
    try {
      const result = body();
      if (isPromiseLike(result)) {
        throw new CollectionError(
          `describe body for ${JSON.stringify(group.title)} must finish synchronously`,
        );
      }
    } finally {
      this.currentGroup = previous;
    }
  }

  registerHook(hook: HookDeclaration): void {
    this.assertOpen(`${hook.kind}()`);
    if (typeof hook.fn !== 'function') {
      throw new CollectionError(`${hook.kind} hook must be a function`);
    }
    const source = captureSource(this.moduleFile);
    this.hooks.push({
      ...hook,
      names: fixtureNames(hook.fn, describeUser(hook), source),
      source,
      group: this.currentGroup,
      declarationIndex: this.declarationCounter,
    });
    this.declarationCounter += 1;
  }
}

/**
 * The truthiness of a `skipIf` or `runIf` condition. A Promise is always
 * truthy, so an unawaited async check would decide nothing; it throws.
 */
function readCondition(api: string, condition: unknown): boolean {
  if (isPromiseLike(condition)) {
    throw new CollectionError(`${api} got a Promise as its condition; await it before the call`);
  }
  return Boolean(condition);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Canonical group-tree walk: the enclosing groups of a node, outermost first. */
export function groupChain(group: GroupNode | undefined): GroupNode[] {
  const chain: GroupNode[] = [];
  for (let node = group; node !== undefined; node = node.parent) {
    chain.unshift(node);
  }
  return chain;
}

/** Group titles along the chain, outermost first. */
export function groupTitles(group: GroupNode | undefined): string[] {
  return groupChain(group).map((node) => node.title);
}

/** The tags along the describe chain and the test's own, outermost first, each once. */
function declaredTags(group: GroupNode | undefined, options: TestOptions): string[] {
  const layers = [...groupChain(group).map((node) => node.options), options];
  return [...new Set(layers.flatMap((layer) => layer.tags ?? []))];
}

/**
 * A suite scope: a describe group, or `undefined` for the file scope. Scopes
 * are the registration's own group nodes, so two sibling groups that happen
 * to share a title stay two scopes with their own hooks.
 */
export type Scope = GroupNode | undefined;

/** The suite scopes `test` is in, outermost first: the file scope, then each describe group around it. */
export function scopeChain(test: Pick<RegisteredTest, 'group'>): Scope[] {
  return [undefined, ...groupChain(test.group)];
}

/**
 * The hooks that apply to `test`, of every kind: those of each scope it is
 * in, outermost scope first, each scope's in declaration order, wherever in
 * the file a scope's hooks were declared relative to the test.
 */
export function hooksFor(registration: Pick<ModuleRegistration, 'hooks'>, test: Pick<RegisteredTest, 'group'>): RegisteredHook[] {
  return scopeChain(test).flatMap((scope) => registration.hooks.filter((hook) => hook.group === scope));
}

/** Finds the outermost serial group enclosing a node, if any. */
export function outermostSerialGroup(group: GroupNode | undefined): GroupNode | undefined {
  return groupChain(group).find((node) => node.serial);
}

/** The keys `test()` takes. */
const TEST_OPTION_KEYS: readonly string[] = Object.keys({
  timeout: true,
  retries: true,
  tags: true,
  skip: true,
  fail: true,
  only: true,
  platforms: true,
  requires: true,
  session: true,
  agentContext: true,
  agent: true,
  trace: true,
  video: true,
  sharedSession: true,
} satisfies Record<keyof TestOptions, true>);

/** The keys `test.setup()` takes beside `sessions`, which registration lifts out first. */
const SETUP_OPTION_KEYS: readonly string[] = Object.keys({
  timeout: true,
  retries: true,
  tags: true,
  platforms: true,
  requires: true,
  agentContext: true,
  agent: true,
  trace: true,
  video: true,
} satisfies Record<Exclude<keyof SetupOptions, 'sessions'>, true>);

/** The keys `test.describe()` takes. */
const DESCRIBE_OPTION_KEYS: readonly string[] = Object.keys({
  timeout: true,
  retries: true,
  tags: true,
  skip: true,
  platforms: true,
  requires: true,
  session: true,
  agentContext: true,
  agent: true,
  trace: true,
  video: true,
  serial: true,
  sharedSession: true,
} satisfies Record<keyof DescribeOptions, true>);

/**
 * The checks tests and groups share: only the option `keys` the call takes,
 * so a misspelled `timout` fails instead of leaving the default in place,
 * and each known option's value.
 */
function validateCommonOptions(options: TestOptions | DescribeOptions, label: string, keys: readonly string[]): void {
  const unknown = unknownKeyMessage(label, options, keys);
  if (unknown !== undefined) throw new CollectionError(unknown);
  if (options.timeout !== undefined) {
    if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0) {
      throw new CollectionError(`${label}: timeout must be a positive safe integer`);
    }
    if (options.timeout > MAX_TIMER_MS) {
      throw new CollectionError(`${label}: timeout must be at most ${MAX_TIMER_MS} milliseconds, got ${options.timeout}`);
    }
  }
  if (options.retries !== undefined) {
    if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 10) {
      throw new CollectionError(`${label}: retries must be an integer from 0 through 10`);
    }
  }
  if (options.agent !== undefined) validateAgentOption(options.agent, label);
  if (options.tags !== undefined) validateTagsOption(options.tags, label);
  for (const kind of ['trace', 'video'] as const) {
    const mode = options[kind];
    if (mode !== undefined && !isRecordingMode(mode)) {
      const legacy = kind === 'trace' ? legacyTraceSpelling(mode) : undefined;
      throw new CollectionError(
        legacy === undefined
          ? `${label}: ${kind} must be one of ${RECORDING_MODES.join(', ')}, got ${describeValue(mode)}`
          : `${label}: trace ${legacy.was} is the old spelling of trace: '${legacy.mode}'; the modes are ${RECORDING_MODES.join(', ')}`,
      );
    }
  }
}

/**
 * `tags` lists distinct tag names, checked here beside `timeout`, `retries`,
 * and `agent`. Unchecked, the mistake is silent: a bare string is iterable,
 * so `tags: 'smoke'` would register the tags `s`, `m`, `o`, `k`, `e` and
 * `--tag smoke` would never select the test.
 */
function validateTagsOption(tags: unknown, label: string): void {
  if (!Array.isArray(tags)) {
    throw new CollectionError(
      `${label}: tags must be a list of tag names, e.g. tags: ['smoke'], got ${describeValue(tags)}`,
    );
  }
  const seen = new Set<string>();
  for (const tag of tags) {
    if (!isTagName(tag)) {
      throw new CollectionError(
        `${label}: every tag must be a non-blank string with no comma and no leading or trailing whitespace, got ${describeValue(tag)}`,
      );
    }
    if (seen.has(tag)) throw new CollectionError(`${label}: tags lists ${JSON.stringify(tag)} twice`);
    seen.add(tag);
  }
}

/**
 * A tag name is whatever `--tag` can spell back: the flag splits its values
 * on commas and trims them, so a name holds no comma and no leading or
 * trailing whitespace. Inner spaces are fine (`'Login Form'`, quoted).
 */
function isTagName(tag: unknown): tag is string {
  return typeof tag === 'string' && tag !== '' && tag.trim() === tag && !tag.includes(',');
}

/** `agent` names one configured agent, or lists several distinct ones to run the test once each. */
function validateAgentOption(agent: unknown, label: string): void {
  if (typeof agent === 'string') {
    if (agent === '') throw new CollectionError(`${label}: agent must be the name of a configured agent`);
    return;
  }
  if (!Array.isArray(agent) || agent.length === 0) {
    throw new CollectionError(
      `${label}: agent must be the name of a configured agent, or a non-empty list of names`,
    );
  }
  for (const name of agent) {
    if (typeof name !== 'string' || name === '') {
      throw new CollectionError(`${label}: every entry of agent must be the name of a configured agent`);
    }
  }
  if (new Set(agent).size !== agent.length) {
    throw new CollectionError(`${label}: agent lists each name once`);
  }
}

function insideSerial(group: GroupNode | undefined): boolean {
  return outermostSerialGroup(group) !== undefined;
}

function validateTestOptions(options: TestOptions, group: GroupNode | undefined, kind: 'test' | 'setup'): void {
  if (kind === 'setup') validateCommonOptions(options, 'setup options', SETUP_OPTION_KEYS);
  else validateCommonOptions(options, 'test options', TEST_OPTION_KEYS);
  const fail: unknown = options.fail;
  if (fail !== undefined && typeof fail !== 'boolean' && typeof fail !== 'string') {
    throw new CollectionError(`test options: fail must be true, false, or a reason string, got ${describeValue(fail)}`);
  }
  if (insideSerial(group)) {
    const forbidden: (keyof TestOptions)[] = [
      'retries',
      'trace',
      'video',
      'session',
      'platforms',
      'requires',
      'skip',
      'fail',
      'only',
    ];
    for (const key of forbidden) {
      if (options[key] !== undefined) {
        throw new CollectionError(
          `test option "${key}" cannot be overridden inside a serial group; it belongs to the unit`,
        );
      }
    }
  }
}

function validateDescribeOptions(options: DescribeOptions, parent: GroupNode | undefined): void {
  validateCommonOptions(options, 'describe options', DESCRIBE_OPTION_KEYS);
  if (options.serial === true && insideSerial(parent)) {
    throw new CollectionError('nested serial groups are collection errors');
  }
  // The serial group records as one unit, so a describe inside it cannot choose its own recordings.
  for (const kind of ['trace', 'video'] as const) {
    if (options[kind] !== undefined && insideSerial(parent)) {
      throw new CollectionError(`describe option "${kind}" cannot be set inside a serial group; set it on the serial group or a group around it`);
    }
  }
}

/**
 * The active collector lives on globalThis because a test module may import a
 * copy of e2e other than the runner's and must still reach the runner's
 * collector instance.
 */
const collectorSlot = realmSlot<Collector>('e2e.activeCollector.v1');

/**
 * Runs `load` with a fresh collector active and returns everything it
 * registered. `moduleFile` is the absolute path of the module `load` imports;
 * a test's source prefers a frame in that file. `redactTitle` is applied to
 * every test and describe title as it registers, so a secret a title spells
 * out never reaches a test id, a report, or a path derived from either; the
 * runner passes the static secrets of the config (`staticSecretLedger`), the
 * same in every process, so ids agree across them.
 */
export async function collectModule(
  load: () => Promise<unknown>,
  moduleFile?: string,
  redactTitle: (title: string) => string = (title) => title,
): Promise<ModuleRegistration> {
  if (collectorSlot.get(globalThis) !== undefined) {
    throw new CollectionError('collection is already in progress');
  }
  const collector = new Collector(moduleFile, redactTitle);
  collectorSlot.set(globalThis, collector);
  try {
    await load();
  } finally {
    collectorSlot.delete(globalThis);
  }
  return collector.close();
}

function requireCollector(api: string): Collector {
  const collector = collectorSlot.get(globalThis);
  if (collector === undefined) {
    throw new CollectionError(
      `${api} can only be called while a test module is being collected by the e2e runner`,
    );
  }
  return collector;
}

const PACKAGE_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
/**
 * The runner's own source roots, whose frames are never a test's location.
 * `dist/` is where the published module runs; `src/` is where it runs in this
 * repository.
 */
const RUNNER_ROOTS = ['src', 'dist'].map((dir) => `${path.join(PACKAGE_ROOT, dir)}${path.sep}`);
const NODE_MODULES_SEGMENT = /[\\/]node_modules[\\/]/;

/** The path with symlinks resolved, or the path itself when it cannot be resolved. */
function realPath(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

/**
 * `at name (location:line:column)` or `at location:line:column`, either one
 * after `async` for an awaiting caller. JavaScriptCore (Bun) can leave the
 * column out of a module's top-level frame.
 */
const STACK_FRAME = /^at (?:async )?(?:[^(]*? \()?(.+?):(\d+)(?::(\d+))?\)?$/;

/**
 * Every frame of the current stack as a source location, the async frames
 * of awaiting callers included (a test file that awaits a helper declaring
 * tests is one), at the source positions Node.js's source maps give them.
 * Read from the stack text: `util.getCallSites` leaves the async frames out,
 * and with source maps on Node.js does not hand `Error.prepareStackTrace`
 * the call sites at all.
 */
function stackLocations(): SourceLocation[] {
  // The default limit of 10 frames cuts the test file's frame off a stack
  // that reaches the runner through a helper, a describe, and `test.each`.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  let stack: string;
  try {
    stack = new Error().stack ?? '';
  } finally {
    Error.stackTraceLimit = limit;
  }
  return stack.split('\n').slice(1).flatMap((line) => {
    const match = STACK_FRAME.exec(line.trim());
    if (match === null) return [];
    // An ES module names itself by URL, the loader's cache-busting query included; a mapped frame or CommonJS by path.
    const file = match[1]!.startsWith('file:') ? fileURLToPath(match[1]!) : match[1]!;
    // A runtime's own code is no file: Bun names its builtins `native`.
    if (!path.isAbsolute(file)) return [];
    return [{ file, line: Number(match[2]), column: Number(match[3] ?? 1) }];
  });
}

/**
 * Where a test was declared, read off the stack of its `test()` call. The
 * innermost frame in the module being collected wins, so a test declared
 * through a project helper (`dashboardTest()` in `support/test.ts`) points at
 * the helper's call in the test file. When no frame is in that module (the
 * file imports a module that declares the tests), the innermost frame outside
 * the runner and outside `node_modules` stands. The runner's own frames,
 * whether source maps relocate them to `src/` or not, and an installed
 * package's frames are never a test's location.
 */
function captureSource(moduleFile: string | undefined): SourceLocation | undefined {
  let outsideModule: SourceLocation | undefined;
  for (const location of stackLocations()) {
    const { file } = location;
    if (RUNNER_ROOTS.some((root) => file.startsWith(root)) || file.startsWith('node:')) continue;
    if (moduleFile !== undefined && (file === moduleFile || realPath(file) === moduleFile)) {
      return location;
    }
    if (outsideModule === undefined && !NODE_MODULES_SEGMENT.test(file)) outsideModule = location;
  }
  return outsideModule;
}

function normalizeArgs<Fn extends TestBody | EachFn<unknown[]>>(
  optionsOrFn: TestOptions | Fn,
  maybeFn: Fn | undefined,
): { options: TestOptions; fn: Fn } {
  if (typeof optionsOrFn === 'function') {
    return { options: {}, fn: optionsOrFn };
  }
  if (maybeFn === undefined) throw new CollectionError('test body function is required');
  return { options: optionsOrFn, fn: maybeFn };
}

/**
 * Checks one `test.extend()` argument against the chain it extends. What
 * each function names is validated here, at import time, so a cycle or a
 * scope that cannot be fails the file before any attempt runs; the engine's
 * own fixtures are only known per target and are checked when a test that
 * runs there is selected (`assertFixtureUse`). A name the chain or the
 * target already has extends that fixture.
 */
function validateFixtureDefinitions(
  definitions: unknown,
  chain: readonly FixtureDefinition[],
): FixtureDefinition[] {
  if (
    typeof definitions !== 'object' ||
    definitions === null ||
    Array.isArray(definitions) ||
    (Object.getPrototypeOf(definitions) !== Object.prototype &&
      Object.getPrototypeOf(definitions) !== null)
  ) {
    throw new CollectionError(
      'test.extend() takes a plain object of fixture definitions, one function per fixture name',
    );
  }
  const added: FixtureDefinition[] = [];
  const layer = (chain.at(-1)?.layer ?? -1) + 1;
  // The innermost frame outside the runner: the `test.extend()` call itself, wherever a test file imports it from.
  const source = captureSource(undefined);
  for (const [name, fn] of Object.entries(definitions)) {
    if (name === '') throw new CollectionError('test.extend(): a fixture name must not be empty');
    const definition = fixtureDefinition(name, fn);
    const names = fixtureNames(definition.fn, describeFixture(name, definition.scope), source);
    added.push({ name, ...definition, names, layer, source });
  }
  checkDeclaredFixtures([...chain, ...added], added);
  return added;
}

/** The function, scope, and `auto` of one `test.extend()` entry: `fn`, or `[fn, { scope, auto }]`. */
function fixtureDefinition(name: string, entry: unknown): Pick<FixtureDefinition, 'fn' | 'scope' | 'auto'> {
  const shape = `test.extend(): fixture "${name}" must be a function ({ ...fixtures }, use) => Promise<void>, or [fn, { scope: 'test' | 'worker', auto: boolean }]`;
  if (typeof entry === 'function') return { fn: entry as FixtureFn<object, unknown>, scope: undefined, auto: undefined };
  if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'function') throw new CollectionError(shape);
  const options: unknown = entry[1];
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new CollectionError(shape);
  const unknown = unknownKeyMessage(`test.extend(): fixture "${name}" options`, options, ['scope', 'auto']);
  if (unknown !== undefined) throw new CollectionError(unknown);
  const { scope, auto } = options as { scope?: unknown; auto?: unknown };
  if (scope !== undefined && scope !== 'test' && scope !== 'worker') {
    throw new CollectionError(`test.extend(): fixture "${name}" scope must be 'test' or 'worker', got ${describeValue(scope)}`);
  }
  if (auto !== undefined && typeof auto !== 'boolean') {
    throw new CollectionError(`test.extend(): fixture "${name}" auto must be true or false, got ${describeValue(auto)}`);
  }
  return { fn: entry[0] as FixtureFn<object, unknown>, scope: scope as FixtureScope | undefined, auto };
}

/**
 * One `test` object per fixture chain. Every registration made through it
 * records the chain, so an attempt knows which fixtures it can set up; the
 * shared `test` is the empty chain.
 */
function createTestAPI(chain: readonly FixtureDefinition[]): TestAPI {
  /**
   * Registers one `test()` call. `api` names the caller in errors. A `skip`
   * condition comes from `skipIf` or `runIf`: when true, the test is
   * skipped, keeping any reason its `skip` option gives. Either way a serial
   * group rejects it, so a file collects the same on every platform.
   * `namedBy` is passed on to `registerTest`.
   */
  const registerOne = (
    api: string,
    skip: boolean | undefined,
    title: string,
    given: TestOptions,
    fn: TestBody,
    namedBy?: { readonly fn: FixtureUserFn; readonly position: number },
  ): TestCase => {
    const collector = requireCollector(api);
    if (skip !== undefined && collector.inSerialGroup) {
      throw new CollectionError(
        `${api} cannot be used inside a serial group, which skips as one unit; ` +
          'set skip on the serial describe instead',
      );
    }
    const options = skip === true
      ? { ...given, skip: typeof given.skip === 'string' ? given.skip : true }
      : given;
    const mode: TestMode = options.only === true ? 'only' : options.skip !== undefined && options.skip !== false ? 'skip' : 'normal';
    return collector.registerTest('test', mode, title, options, [], fn, chain, namedBy);
  };
  /** The `test()` call forms. */
  const registrar = (api: string, skip?: boolean): TestRegistrar<object> => (
    title: string,
    optionsOrFn: TestOptions | TestBody,
    maybeFn?: TestBody,
  ): TestCase => {
    requireCollector(api);
    const { options, fn } = normalizeArgs(optionsOrFn, maybeFn);
    return registerOne(api, skip, title, options, fn);
  };
  const testFunction = registrar('test()');

  /**
   * The `test.each` and `test.for` call forms: one `test()` per row, in row
   * order, titled from the row. `spread` passes each array row's items as
   * the body's first arguments; it is decided once for the table, like
   * Vitest and Jest, so it only applies when every row is an array.
   * Otherwise the row is the first argument. The fixtures always come last.
   */
  const eachRegistrar = (api: string, rows: readonly unknown[], spread: boolean): EachRegistrar<unknown[]> => {
    // Array.from, not every: a hole in the rows is a row too, `undefined`.
    const spreadRows = spread && Array.from(rows).every((row) => Array.isArray(row));
    return (
      title: string,
      optionsOrFn: TestOptions | EachFn<unknown[]>,
      maybeFn?: EachFn<unknown[]>,
    ): readonly TestCase[] => {
      requireCollector(api);
      const { options, fn: body } = normalizeArgs(optionsOrFn, maybeFn);
      if (typeof body !== 'function') throw new CollectionError('test body must be a function');
      return Array.from(rows, (row, index) => {
        const args: unknown[] = spreadRows ? [...(row as unknown[])] : [row];
        const rowTitle = typeof title === 'string' ? formatEachTitle(title, row, index) : title;
        // The row comes first, so the body names its fixtures in the parameter after it.
        return registerOne(api, undefined, rowTitle, options, (fixtures) => body(...args, fixtures), {
          fn: body,
          position: args.length,
        });
      });
    };
  };

  const api: TestAPI = Object.assign(testFunction, {
    skip(first?: string | boolean, second?: TestBody | string): TestCase | undefined {
      const call = parseModifierCall(first, second);
      if (call.kind === 'register') {
        return requireCollector('test.skip()').registerTest('test', 'skip', call.title, { skip: true }, [], call.fn as TestBody, chain);
      }
      skipRunningTest(call.condition, call.reason);
      return undefined;
    },
    fail(first?: string | boolean, second?: TestBody | string): TestCase | undefined {
      const call = parseModifierCall(first, second);
      if (call.kind === 'register') {
        return requireCollector('test.fail()').registerTest('test', 'normal', call.title, { fail: true }, [], call.fn as TestBody, chain);
      }
      markRunningTestExpectedToFail(call.condition, call.reason);
      return undefined;
    },
    skipIf(condition: unknown): TestRegistrar<object> {
      return registrar('test.skipIf()', readCondition('test.skipIf()', condition));
    },
    runIf(condition: unknown): TestRegistrar<object> {
      return registrar('test.runIf()', !readCondition('test.runIf()', condition));
    },
    each(rows: unknown): EachRegistrar<unknown[]> {
      return eachRegistrar('test.each()', readRows('test.each()', rows), true);
    },
    for(rows: unknown): EachRegistrar<unknown[]> {
      return eachRegistrar('test.for()', readRows('test.for()', rows), false);
    },
    only(title: string, fn: TestBody): TestCase {
      return requireCollector('test.only()').registerTest('test', 'only', title, { only: true }, [], fn, chain);
    },
    setup(title: string, options: SetupOptions, fn: TestBody): TestCase {
      if (options === undefined || !Array.isArray(options.sessions)) {
        throw new CollectionError('test.setup() requires a static sessions list');
      }
      const { sessions, ...rest } = options;
      return requireCollector('test.setup()').registerTest('setup', 'normal', title, rest, sessions, fn, chain);
    },
    describe<Result>(
      title: string,
      optionsOrBody: DescribeOptions | (() => Result),
      maybeBody?: () => Result,
    ): void {
      const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
      const body = typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody;
      if (body === undefined) throw new CollectionError('describe body function is required');
      requireCollector('describe()').registerDescribe(title, options, body);
    },
    beforeEach(fn: TestBody): void {
      requireCollector('beforeEach()').registerHook({ kind: 'beforeEach', fn, fixtures: chain });
    },
    afterEach(fn: TestBody): void {
      requireCollector('afterEach()').registerHook({ kind: 'afterEach', fn, fixtures: chain });
    },
    beforeAll(fn: TestBody): void {
      requireCollector('beforeAll()').registerHook({ kind: 'beforeAll', fn, fixtures: chain });
    },
    afterAll(fn: TestBody): void {
      requireCollector('afterAll()').registerHook({ kind: 'afterAll', fn, fixtures: chain });
    },
    // Without definitions this is a type-only refinement: contributed
    // fixtures resolve from the engine at runtime, so the same object serves.
    // With definitions it is a new object, so the shared `test` never changes.
    extend(definitions?: unknown): TestAPI {
      if (definitions === undefined) return api;
      return createTestAPI([...chain, ...validateFixtureDefinitions(definitions, chain)]);
    },
  }) as TestAPI;
  return api;
}

export const test: TestAPI = createTestAPI([]);

/**
 * `test.describe` and the hooks as top-level imports. The per-test hooks
 * carry the core fixtures; a hook that needs a `test.extend()` fixture
 * registers through that `test`, or an engine's re-export of these.
 */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
