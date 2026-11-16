/**
 * One temporary Runner for the HTTP gateway: a child process the gateway
 * forks with the project directory, the config path, one target, and a
 * directory for this run's output. It owns the actual dynamic run, accepts
 * submissions over IPC, and reports acceptance and per-test results back.
 *
 * The child is the only place project code runs for a job; the gateway never
 * loads the config. A message that does not parse is ignored, never run.
 */

import path from 'node:path';
import { classifyError, ConfigurationError, isE2EError, type SerializedError } from '../internal/errors.ts';
import { resultId } from '../internal/ids.ts';
import type { FailureEvidence, SerialGroupRecord } from './records.ts';
import type { RunEvent, RunEventResult } from './events.ts';
import {
  MAX_IPC_EVIDENCE_LINES,
  MAX_IPC_RESULT_IDS,
  MAX_IPC_TEXT_CHARS,
  MAX_IPC_TITLE_CHARS,
  parseGatewayMessage,
  type HostMessage,
  type IpcArtifact,
  type IpcAttemptError,
  type IpcError,
  type IpcJobPhase,
  type IpcResult,
} from './dynamic-ipc.ts';
import { runDynamic, type DynamicRun } from './public-run.ts';
import { processSecrets } from './secrecy.ts';

interface HostOptions {
  readonly cwd: string;
  readonly config: string | undefined;
  readonly target: string;
  readonly output: string;
  readonly maxWorkers: number | undefined;
}

const options = parseArgs(process.argv.slice(2));
if (options === undefined) {
  process.stderr.write('e2e dynamic host: expected --cwd, --target, --output, and optional --config and --max-workers\n');
  process.exit(2);
}

const jobsByResult = new Map<string, string>();
/** Live jobs and how many of their results are still to come. */
const jobProgress = new Map<string, { expected: number; sent: number }>();
const serialGroups = new Map<string, SerialGroupRecord>();
/** Shared setup results this run accepted and has not finished yet. */
const pendingSetups = new Set<string>();
let runError: IpcError | undefined;
let stopping = false;

const controller = new AbortController();
const active: DynamicRun = runDynamic({
  cwd: options.cwd,
  ...(options.config === undefined ? {} : { config: options.config }),
  target: options.target,
  ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
  output: options.output,
  interruptSignal: controller.signal,
  onEvent: (event) => observe(event),
});

// Tests delay readiness to exercise the gateway's startup deadline.
const readyDelayMs = Number(process.env['E2E_HTTP_MCP_READY_DELAY_MS']);
if (Number.isSafeInteger(readyDelayMs) && readyDelayMs > 0) {
  setTimeout(() => send({ v: 1, type: 'ready', runId: active.runId }), readyDelayMs);
} else {
  send({ v: 1, type: 'ready', runId: active.runId });
}

process.on('message', (raw: unknown) => {
  const message = parseGatewayMessage(raw);
  if (message === undefined) return;
  switch (message.type) {
    case 'submit':
      void submit(message.jobId, message.files);
      break;
    case 'seal':
      active.seal();
      break;
    case 'stop':
      stopping = true;
      controller.abort();
      break;
  }
});

// The parent is the only reader; once it is gone, nothing should keep running.
process.on('disconnect', () => {
  stopping = true;
  controller.abort();
});

process.on('uncaughtException', (cause) => {
  send({ v: 1, type: 'run-error', error: toIpcError(cause, 'run') });
  process.exit(1);
});
process.on('unhandledRejection', (cause) => {
  send({ v: 1, type: 'run-error', error: toIpcError(cause, 'run') });
  process.exit(1);
});

void active.result.then(
  () => {
    // The run's own `run-finished` event was sent by `observe`.
    finishHost(0);
  },
  (cause: unknown) => {
    send({ v: 1, type: 'run-finished', status: 'error', exitCode: 4, error: toIpcError(cause, 'run') });
    finishHost(1);
  },
);

/** Leaves once the parent has the last message; a test's stray handle cannot pin the run slot. */
function finishHost(code: number): void {
  process.disconnect?.();
  setTimeout(() => process.exit(code), 100);
}

async function submit(jobId: string, files: readonly string[]): Promise<void> {
  try {
    if (stopping) throw new ConfigurationError('INVALID_ARGUMENT', 'the dynamic run is closing');
    const receipt = await active.submit({ jobId, files });
    if (receipt.resultIds.length === 0) {
      send({
        v: 1,
        type: 'rejected',
        jobId,
        error: { code: 'NO_TESTS', category: 'configuration', message: 'the submission selected no tests', phase: 'collection' },
      });
      return;
    }
    // The gateway's accepted message carries at most this many ids; a larger
    // selection would be dropped there and leave the job stuck, so refuse it.
    if (receipt.resultIds.length > MAX_IPC_RESULT_IDS) {
      send({
        v: 1,
        type: 'rejected',
        jobId,
        error: {
          code: 'INVALID_ARGUMENT',
          category: 'configuration',
          message: `the submission selected ${receipt.resultIds.length} tests; a job runs at most ${MAX_IPC_RESULT_IDS}`,
          phase: 'collection',
        },
      });
      return;
    }
    for (const id of receipt.setupIds) pendingSetups.add(id);
    for (const id of receipt.resultIds) jobsByResult.set(id, jobId);
    jobProgress.set(jobId, { expected: receipt.resultIds.length, sent: 0 });
    const awaitingAuth = pendingSetups.size > 0;
    send({ v: 1, type: 'accepted', jobId, resultIds: receipt.resultIds, awaitingAuth });
    send({ v: 1, type: 'phase', jobId, phase: awaitingAuth ? 'waiting_auth' : 'running' });
  } catch (cause) {
    send({ v: 1, type: 'rejected', jobId, error: toIpcError(cause, 'collection') });
  }
}

function observe(event: RunEvent): void {
  switch (event.type) {
    case 'serial-group':
      serialGroups.set(event.group.id, event.group);
      break;
    case 'test-started': {
      const id = resultId(event.testId, event.target, event.agent, event.repeat);
      const jobId = jobsByResult.get(id);
      if (jobId !== undefined) send({ v: 1, type: 'phase', jobId, phase: 'running', started: true });
      break;
    }
    case 'test-finished':
      finishResult(event.result);
      break;
    case 'run-error':
      runError = toIpcError(event.error, phaseOf(event.error));
      send({ v: 1, type: 'run-error', error: runError });
      break;
    case 'run-finished':
      send({
        v: 1,
        type: 'run-finished',
        status: event.status,
        exitCode: event.exitCode,
        ...(runError === undefined ? {} : { error: runError }),
      });
      break;
    default:
      break;
  }
}

function finishResult(result: RunEventResult): void {
  if (result.test.kind === 'setup') {
    // This setup is done, whether it passed or failed. Jobs wait until every
    // setup this run accepted has finished, not just the first.
    const setupId = resultId(result.test.id, result.target.name, result.agent, result.repeat);
    if (pendingSetups.delete(setupId) && pendingSetups.size === 0) {
      for (const jobId of jobProgress.keys()) send({ v: 1, type: 'phase', jobId, phase: 'running' });
    }
    if (result.status === 'passed' || result.status === 'skipped') return;
    const failure = failureOf(result, undefined);
    if (failure === undefined) return;
    runError = { ...failure.error, phase: 'auth' };
    send({ v: 1, type: 'run-error', error: runError });
    return;
  }
  const id = resultId(result.test.id, result.target.name, result.agent, result.repeat);
  const jobId = jobsByResult.get(id);
  if (jobId === undefined) return;
  const progress = jobProgress.get(jobId);
  if (progress !== undefined) {
    progress.sent += 1;
    if (progress.sent >= progress.expected) jobProgress.delete(jobId);
  }
  send({ v: 1, type: 'result', jobId, result: projectResult(result, id) });
}

function projectResult(result: RunEventResult, id: string): IpcResult {
  const group = result.serialGroupId === undefined ? undefined : serialGroups.get(result.serialGroupId);
  const attempts = group === undefined ? result.attempts : serialAttempts(group, result.test.id);
  const failure = failureOf(result, attempts);
  const skip = result.skip?.reason;
  return {
    resultId: id,
    title: clean(result.test.title, MAX_IPC_TITLE_CHARS),
    titlePath: result.test.titlePath.slice(-20).map((part) => clean(part, MAX_IPC_TITLE_CHARS)),
    file: result.test.file,
    status: result.status,
    durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    attempts: attempts.length,
    ...(failure === undefined ? {} : { failure }),
    ...(skip === undefined ? {} : { skip: clean(skip, MAX_IPC_TEXT_CHARS) }),
    ...(result.skip?.cause === undefined ? {} : { skipCause: result.skip.cause }),
  };
}

interface AttemptView {
  readonly status: string;
  readonly durationMs: number;
  readonly error?: SerializedError;
  readonly failure?: FailureEvidence;
  readonly artifacts?: readonly { kind: IpcArtifact['kind']; mediaType: string; size?: number }[];
}

/** A serial member's attempts live on the group; its own error and evidence are the member's. */
function serialAttempts(group: SerialGroupRecord, testId: string): AttemptView[] {
  return group.attempts.map((attempt) => {
    const member = attempt.members.find((candidate) => candidate.testId === testId);
    return {
      status: attempt.status,
      durationMs: attempt.durationMs,
      ...(member?.error === undefined ? (attempt.error === undefined ? {} : { error: attempt.error }) : { error: member.error }),
      ...(member?.failure === undefined ? {} : { failure: member.failure }),
      artifacts: attempt.artifacts,
    };
  });
}

function failureOf(result: RunEventResult, attempts: readonly AttemptView[] | undefined): IpcAttemptError | undefined {
  const runs = attempts ?? result.attempts;
  const failed = runs.findLast((attempt) => attempt.status === 'failed' || attempt.status === 'timed-out' || attempt.status === 'interrupted');
  if (failed === undefined) return undefined;
  const evidence = failed.failure?.candidates?.slice(0, MAX_IPC_EVIDENCE_LINES).map((line) => clean(line, MAX_IPC_TEXT_CHARS));
  const artifacts = failed.artifacts?.slice(0, 20).map((artifact) => ({
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    ...(artifact.size === undefined ? {} : { size: artifact.size }),
  }));
  return {
    status: failed.status as IpcAttemptError['status'],
    durationMs: failed.durationMs,
    error: failed.error === undefined ? { code: 'ERROR', category: 'test', message: 'the attempt failed' } : toIpcError(failed.error, 'run'),
    ...(evidence === undefined ? {} : { evidence }),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

function toIpcError(cause: unknown, phase: IpcJobPhase): IpcError {
  // Run errors and attempt errors reach this host already serialized.
  const serialized = serializedError(cause);
  if (serialized !== undefined) return { ...serialized, phase };
  if (isE2EError(cause)) {
    return {
      code: cause.code,
      category: cause.category,
      message: clean(cause.message, MAX_IPC_TEXT_CHARS),
      phase,
      retryable: cause.retryable,
    };
  }
  const error = classifyError(cause);
  return {
    code: error.code,
    category: error.category,
    message: clean(error.message, MAX_IPC_TEXT_CHARS),
    phase,
    retryable: isE2EError(error) ? error.retryable : false,
  };
}

function serializedError(value: unknown): IpcError | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const code = record['code'];
  const category = record['category'];
  const message = record['message'];
  if (typeof code !== 'string' || typeof message !== 'string' || typeof category !== 'string') return undefined;
  if (!['test', 'configuration', 'infrastructure', 'internal', 'interrupted'].includes(category)) return undefined;
  return {
    code,
    category: category as IpcError['category'],
    message: clean(message, MAX_IPC_TEXT_CHARS),
    retryable: record['retryable'] === true,
  };
}

function phaseOf(error: { code: string; phase?: string }): IpcJobPhase {
  if (error.code === 'COLLECTION_ERROR' || error.code === 'NO_TESTS' || error.phase === 'collection' || error.phase === 'config') return 'collection';
  return 'run';
}

/** One line, bounded, no control characters, no secret and no project root: a tool result. */
function clean(value: string, max: number): string {
  let text = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const piece = code < 0x20 || code === 0x7f ? ' ' : character;
    // An astral character is two UTF-16 units; never cross the bound, since
    // the gateway rejects a whole message that exceeds it.
    if (text.length + piece.length > max) break;
    text += piece;
  }
  return processSecrets.redact(text).replaceAll(`${process.cwd()}${path.sep}`, '');
}

function send(message: HostMessage): void {
  if (process.connected === false) return;
  process.send?.(message);
}

function parseArgs(argv: readonly string[]): HostOptions | undefined {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !['--cwd', '--config', '--target', '--output', '--max-workers'].includes(flag)) {
      return undefined;
    }
    if (values.has(flag)) return undefined;
    values.set(flag, value);
  }
  const cwd = values.get('--cwd');
  const target = values.get('--target');
  const output = values.get('--output');
  if (cwd === undefined || target === undefined || output === undefined) return undefined;
  const rawWorkers = values.get('--max-workers');
  const maxWorkers = rawWorkers === undefined ? undefined : Number(rawWorkers);
  if (maxWorkers !== undefined && (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1)) return undefined;
  return { cwd: path.resolve(cwd), config: values.get('--config'), target, output: path.resolve(output), maxWorkers };
}
