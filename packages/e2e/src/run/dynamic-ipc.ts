/**
 * The private channel between the gateway and one temporary Runner child.
 *
 * Both ends parse every message into these closed shapes before acting on it:
 * the gateway ignores a child message it cannot read, and the child ignores a
 * gateway message it cannot read. A malformed message is never a command.
 * Version 1 is the only version; a change to a field's meaning bumps it.
 */

/** The one protocol version both ends speak. */
const DYNAMIC_IPC_VERSION = 1;

const MAX_IPC_JOB_ID_CHARS = 128;
export const MAX_IPC_FILES = 50;
const MAX_IPC_FILE_CHARS = 512;
export const MAX_IPC_RESULT_IDS = 1000;
export const MAX_IPC_TEXT_CHARS = 4096;
export const MAX_IPC_TITLE_CHARS = 500;
export const MAX_IPC_EVIDENCE_LINES = 5;
const MAX_IPC_ARTIFACTS = 20;

export type IpcErrorCategory = 'test' | 'configuration' | 'infrastructure' | 'internal' | 'interrupted';
export type IpcJobPhase = 'collection' | 'auth' | 'run';
export type IpcResultStatus = 'passed' | 'flaky' | 'failed' | 'timed-out' | 'interrupted' | 'skipped';
/** Why a test did not run, closed to the runner's own causes. */
export type IpcSkipCause =
  | 'explicit'
  | 'filtered'
  | 'platform-unavailable'
  | 'capability-unavailable'
  | 'setup-failed'
  | 'serial-predecessor-failed'
  | 'hook-failed'
  | 'infrastructure-unavailable'
  | 'failure-limit'
  | 'time-limit';

/** A classified failure, small enough to cross the channel and persist. */
export interface IpcError {
  readonly code: string;
  readonly category: IpcErrorCategory;
  readonly message: string;
  readonly phase?: IpcJobPhase;
  readonly retryable?: boolean;
}

/** One artifact a failing attempt kept, described without a filesystem path. */
export interface IpcArtifact {
  readonly kind: 'screenshot' | 'video' | 'download' | 'log';
  readonly mediaType: string;
  readonly size?: number;
}

/** One failed attempt's evidence, bounded. */
export interface IpcAttemptError {
  readonly status: 'failed' | 'timed-out' | 'interrupted';
  readonly durationMs: number;
  readonly error: IpcError;
  readonly evidence?: readonly string[];
  readonly artifacts?: readonly IpcArtifact[];
}

/** One test result as a job report carries it. */
export interface IpcResult {
  readonly resultId: string;
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly file: string;
  readonly status: IpcResultStatus;
  readonly durationMs: number;
  readonly attempts: number;
  readonly failure?: IpcAttemptError;
  readonly skip?: string;
  readonly skipCause?: IpcSkipCause;
}

/** What the child sends: lifecycle, acceptance, and results. */
export type HostMessage =
  | { readonly v: 1; readonly type: 'ready'; readonly runId: string }
  | {
      readonly v: 1;
      readonly type: 'accepted';
      readonly jobId: string;
      readonly resultIds: readonly string[];
      /** Whether the job's tests wait for a setup this run has not finished. */
      readonly awaitingAuth: boolean;
    }
  | { readonly v: 1; readonly type: 'rejected'; readonly jobId: string; readonly error: IpcError }
  | {
      readonly v: 1;
      readonly type: 'phase';
      readonly jobId: string;
      readonly phase: 'waiting_auth' | 'running';
      /** One of the job's own tests started, as opposed to authentication settling. */
      readonly started?: boolean;
    }
  | { readonly v: 1; readonly type: 'result'; readonly jobId: string; readonly result: IpcResult }
  | { readonly v: 1; readonly type: 'run-error'; readonly error: IpcError }
  | {
      readonly v: 1;
      readonly type: 'run-finished';
      readonly status: string;
      readonly exitCode: number;
      readonly error?: IpcError;
    };

/** What the gateway sends: one submission, or a request to stop taking work. */
export type GatewayMessage =
  | { readonly v: 1; readonly type: 'submit'; readonly jobId: string; readonly files: readonly string[] }
  | { readonly v: 1; readonly type: 'seal' }
  | { readonly v: 1; readonly type: 'stop' };

const CATEGORIES: ReadonlySet<string> = new Set<IpcErrorCategory>(['test', 'configuration', 'infrastructure', 'internal', 'interrupted']);
const PHASES: ReadonlySet<string> = new Set<IpcJobPhase>(['collection', 'auth', 'run']);
const RESULT_STATUSES: ReadonlySet<string> = new Set<IpcResultStatus>(['passed', 'flaky', 'failed', 'timed-out', 'interrupted', 'skipped']);
const ARTIFACT_KINDS: ReadonlySet<string> = new Set(['screenshot', 'video', 'download', 'log']);
const ATTEMPT_STATUSES: ReadonlySet<string> = new Set(['failed', 'timed-out', 'interrupted']);
const SKIP_CAUSES: ReadonlySet<string> = new Set<IpcSkipCause>([
  'explicit',
  'filtered',
  'platform-unavailable',
  'capability-unavailable',
  'setup-failed',
  'serial-predecessor-failed',
  'hook-failed',
  'infrastructure-unavailable',
  'failure-limit',
  'time-limit',
]);

/** Parses one child message; undefined when it is not exactly a valid one. */
export function parseHostMessage(raw: unknown): HostMessage | undefined {
  const message = object(raw);
  if (message === undefined || message['v'] !== DYNAMIC_IPC_VERSION) return undefined;
  switch (message['type']) {
    case 'ready': {
      const runId = text(message['runId'], MAX_IPC_JOB_ID_CHARS);
      return runId === undefined ? undefined : { v: 1, type: 'ready', runId };
    }
    case 'accepted': {
      const jobId = text(message['jobId'], MAX_IPC_JOB_ID_CHARS);
      const ids = message['resultIds'];
      const awaitingAuth = message['awaitingAuth'];
      if (jobId === undefined || !Array.isArray(ids) || ids.length > MAX_IPC_RESULT_IDS) return undefined;
      if (typeof awaitingAuth !== 'boolean') return undefined;
      const resultIds = ids.flatMap((id) => {
        const value = text(id, MAX_IPC_JOB_ID_CHARS);
        return value === undefined ? [] : [value];
      });
      if (resultIds.length !== ids.length) return undefined;
      return { v: 1, type: 'accepted', jobId, resultIds, awaitingAuth };
    }
    case 'rejected': {
      const jobId = text(message['jobId'], MAX_IPC_JOB_ID_CHARS);
      const error = parseIpcError(message['error']);
      return jobId === undefined || error === undefined ? undefined : { v: 1, type: 'rejected', jobId, error };
    }
    case 'phase': {
      const jobId = text(message['jobId'], MAX_IPC_JOB_ID_CHARS);
      const phase = message['phase'];
      const started = message['started'];
      if (jobId === undefined || (phase !== 'waiting_auth' && phase !== 'running')) return undefined;
      if (started !== undefined && typeof started !== 'boolean') return undefined;
      return { v: 1, type: 'phase', jobId, phase, ...(started === undefined ? {} : { started }) };
    }
    case 'result': {
      const jobId = text(message['jobId'], MAX_IPC_JOB_ID_CHARS);
      const result = parseIpcResult(message['result']);
      return jobId === undefined || result === undefined ? undefined : { v: 1, type: 'result', jobId, result };
    }
    case 'run-error': {
      const error = parseIpcError(message['error']);
      return error === undefined ? undefined : { v: 1, type: 'run-error', error };
    }
    case 'run-finished': {
      const status = text(message['status'], 32);
      const exitCode = message['exitCode'];
      if (status === undefined || typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return undefined;
      const error = message['error'] === undefined ? undefined : parseIpcError(message['error']);
      return { v: 1, type: 'run-finished', status, exitCode, ...(error === undefined ? {} : { error }) };
    }
    default:
      return undefined;
  }
}

/** Parses one gateway message; undefined when it is not exactly a valid one. */
export function parseGatewayMessage(raw: unknown): GatewayMessage | undefined {
  const message = object(raw);
  if (message === undefined || message['v'] !== DYNAMIC_IPC_VERSION) return undefined;
  switch (message['type']) {
    case 'submit': {
      const jobId = text(message['jobId'], MAX_IPC_JOB_ID_CHARS);
      const files = message['files'];
      if (jobId === undefined || !Array.isArray(files) || files.length === 0 || files.length > MAX_IPC_FILES) return undefined;
      const parsed = files.flatMap((file) => {
        const value = filePath(file);
        return value === undefined ? [] : [value];
      });
      if (parsed.length !== files.length) return undefined;
      return { v: 1, type: 'submit', jobId, files: parsed };
    }
    case 'seal':
      return { v: 1, type: 'seal' };
    case 'stop':
      return { v: 1, type: 'stop' };
    default:
      return undefined;
  }
}

/** A JSON object with string keys, or undefined. */
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A non-empty single-line string within a bound, or undefined. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined;
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) < 0x20) return undefined;
  }
  return value;
}

/**
 * A project-relative test file selector: no absolute path, no traversal, no
 * backslash, bounded. The runner still matches it against discovered files;
 * this only keeps a job from naming a path outside the project.
 */
export function filePath(value: unknown): string | undefined {
  const path = text(value, MAX_IPC_FILE_CHARS);
  if (path === undefined) return undefined;
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return undefined;
  if (path.split('/').some((segment) => segment === '..')) return undefined;
  return path;
}

/** A job id: the gateway's uuidv7, or any bounded token in tests. */
export function jobIdText(value: unknown): string | undefined {
  return text(value, MAX_IPC_JOB_ID_CHARS);
}

/** Parses one stored or received error; undefined when it is not exactly one. */
export function parseIpcError(value: unknown): IpcError | undefined {
  const error = object(value);
  if (error === undefined) return undefined;
  const code = text(error['code'], 64);
  const category = error['category'];
  const message = textValue(error['message'], MAX_IPC_TEXT_CHARS);
  if (code === undefined || typeof category !== 'string' || !CATEGORIES.has(category) || message === undefined) return undefined;
  const phase = error['phase'];
  if (phase !== undefined && (typeof phase !== 'string' || !PHASES.has(phase))) return undefined;
  const retryable = error['retryable'];
  if (retryable !== undefined && typeof retryable !== 'boolean') return undefined;
  return {
    code,
    category: category as IpcErrorCategory,
    message,
    ...(phase === undefined ? {} : { phase: phase as IpcJobPhase }),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

/** Parses one stored or received result; undefined when it is not exactly one. */
export function parseIpcResult(value: unknown): IpcResult | undefined {
  const result = object(value);
  if (result === undefined) return undefined;
  const resultId = text(result['resultId'], MAX_IPC_JOB_ID_CHARS);
  const title = text(result['title'], MAX_IPC_TITLE_CHARS);
  const file = filePath(result['file']);
  const status = result['status'];
  const durationMs = result['durationMs'];
  const attempts = result['attempts'];
  if (
    resultId === undefined ||
    title === undefined ||
    file === undefined ||
    typeof status !== 'string' ||
    !RESULT_STATUSES.has(status) ||
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    typeof attempts !== 'number' ||
    !Number.isInteger(attempts) ||
    attempts < 0
  ) {
    return undefined;
  }
  const titlePath = result['titlePath'];
  if (!Array.isArray(titlePath) || titlePath.length > 20) return undefined;
  const titles = titlePath.flatMap((part) => {
    const partTitle = text(part, MAX_IPC_TITLE_CHARS);
    return partTitle === undefined ? [] : [partTitle];
  });
  if (titles.length !== titlePath.length) return undefined;
  const failure = result['failure'] === undefined ? undefined : attemptError(result['failure']);
  if (result['failure'] !== undefined && failure === undefined) return undefined;
  const skip = result['skip'] === undefined ? undefined : textValue(result['skip'], MAX_IPC_TEXT_CHARS);
  if (result['skip'] !== undefined && skip === undefined) return undefined;
  const skipCause = result['skipCause'];
  if (skipCause !== undefined && (typeof skipCause !== 'string' || !SKIP_CAUSES.has(skipCause))) return undefined;
  return {
    resultId,
    title,
    titlePath: titles,
    file,
    status: status as IpcResultStatus,
    durationMs,
    attempts,
    ...(failure === undefined ? {} : { failure }),
    ...(skip === undefined ? {} : { skip }),
    ...(skipCause === undefined ? {} : { skipCause: skipCause as IpcSkipCause }),
  };
}

function attemptError(value: unknown): IpcAttemptError | undefined {
  const attempt = object(value);
  if (attempt === undefined) return undefined;
  const status = attempt['status'];
  const durationMs = attempt['durationMs'];
  const error = parseIpcError(attempt['error']);
  if (typeof status !== 'string' || !ATTEMPT_STATUSES.has(status) || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || error === undefined) {
    return undefined;
  }
  const evidence = attempt['evidence'];
  if (evidence !== undefined && (!Array.isArray(evidence) || evidence.length > MAX_IPC_EVIDENCE_LINES)) return undefined;
  const lines = evidence === undefined ? undefined : evidence.flatMap((line) => {
    const lineText = textValue(line, MAX_IPC_TEXT_CHARS);
    return lineText === undefined ? [] : [lineText];
  });
  if (evidence !== undefined && lines!.length !== evidence.length) return undefined;
  const artifacts = attempt['artifacts'];
  if (artifacts !== undefined && (!Array.isArray(artifacts) || artifacts.length > MAX_IPC_ARTIFACTS)) return undefined;
  const described = artifacts === undefined ? undefined : artifacts.flatMap((artifact) => {
    const artifactView = ipcArtifact(artifact);
    return artifactView === undefined ? [] : [artifactView];
  });
  if (artifacts !== undefined && described!.length !== artifacts.length) return undefined;
  return {
    status: status as IpcAttemptError['status'],
    durationMs,
    error,
    ...(lines === undefined ? {} : { evidence: lines }),
    ...(described === undefined ? {} : { artifacts: described }),
  };
}

function ipcArtifact(value: unknown): IpcArtifact | undefined {
  const artifact = object(value);
  if (artifact === undefined) return undefined;
  const kind = artifact['kind'];
  const mediaType = text(artifact['mediaType'], 128);
  if (typeof kind !== 'string' || !ARTIFACT_KINDS.has(kind) || mediaType === undefined) return undefined;
  const size = artifact['size'];
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size < 0)) return undefined;
  return { kind: kind as IpcArtifact['kind'], mediaType, ...(size === undefined ? {} : { size }) };
}

/** A string that may be empty (an error message can be), still bounded and single-line. */
function textValue(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length > max) return undefined;
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) < 0x20) return undefined;
  }
  return value;
}
