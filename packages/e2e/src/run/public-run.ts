import { AsyncResource } from 'node:async_hooks';
import path from 'node:path';
import { packageVersion } from '../internal/package-version.ts';
import { runsFromCheckout } from '../telemetry/checkout.ts';
import { runCompletedEvent } from '../telemetry/events.ts';
import { Telemetry } from '../telemetry/telemetry.ts';
import type { Report } from '../types.ts';
import type { RunEventSink, RunExitCode, RunStatus } from './events.ts';
import { withProcessOutput, type RunnerOutput } from './process-output.ts';
import { reserveSuiteRun } from './public-ownership.ts';
import { processSecrets } from './secrecy.ts';
import { uuidv7 } from '../internal/ids.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { DynamicRunInput, type DynamicSubmission, type DynamicSubmitOptions } from './dynamic-input.ts';
import {
  run as execute,
  toSelectionRunOptions,
  type ListOptions,
  type RunOptions as InternalRunOptions,
  type RunOutcome,
} from './runner.ts';

/** Options for executing a suite through the public runner API. */
export type SuiteRunOptions = Pick<ListOptions, 'cwd' | 'config' | 'files' | 'changedSince'> & Pick<InternalRunOptions, 'interruptSignal' | 'onEvent'>;

/** The completed run's report and output paths, without live engine or configuration handles. */
export interface RunResult {
  readonly exitCode: RunExitCode;
  readonly status: RunStatus;
  readonly report: Report;
  readonly reportPath: string | undefined;
  readonly aiTracePath: string | undefined;
}

/** What a public call takes from its caller to place the run and follow it. */
interface CallerOptions {
  readonly cwd?: string | undefined;
  readonly interruptSignal?: AbortSignal | undefined;
  readonly onEvent?: RunEventSink | undefined;
}

/** What the internal run receives in their place: output it owns, and the caller's cancellation and sink bound into its async context. */
interface OwnedRunOptions {
  readonly quiet: true;
  readonly processOutput: RunnerOutput;
  readonly interruptSignal: AbortSignal | undefined;
  readonly onEvent: RunEventSink | undefined;
}

/** Executes a suite without exiting the caller; await its cleanup before starting another run. */
export async function runSuite(options: SuiteRunOptions = {}): Promise<RunResult> {
  const outcome = await ownedRun('runner.run', options, (owned) =>
    execute({
      ...toSelectionRunOptions({ cwd: options.cwd, config: options.config, files: options.files, changedSince: options.changedSince }),
      ...owned,
    }),
  );
  return runResult(outcome);
}

/**
 * One public runner call: reserves the process before anything can change
 * its registries, owns and redacts its output, binds the caller's
 * cancellation and event sink into the run's async context, and records the
 * completed run's telemetry under `command`. The reservation is released
 * however `start` ends.
 */
export async function ownedRun<T extends RunOutcome>(
  command: string,
  caller: CallerOptions,
  start: (owned: OwnedRunOptions) => Promise<T>,
): Promise<T> {
  const release = reserveSuiteRun();
  try {
    const telemetry = new Telemetry({
      version: packageVersion(import.meta.url, '../../package.json', '0.0.0'),
      checkout: runsFromCheckout(import.meta.url),
      cwd: path.resolve(caller.cwd ?? process.cwd()),
    });
    telemetry.notice();
    const onEvent = caller.onEvent === undefined ? undefined : AsyncResource.bind(caller.onEvent);
    const outcome = await withProcessOutput(processSecrets, async (processOutput) => {
      const interrupt = ownedInterrupt(caller.interruptSignal);
      try {
        return await start({ quiet: true, processOutput, interruptSignal: interrupt.signal, onEvent });
      } finally {
        interrupt.dispose();
      }
    });
    telemetry.record(runCompletedEvent(outcome.report, { command, flags: [], config: outcome.config }));
    // The caller's result never waits on the network; the send has its own deadline.
    void telemetry.flush();
    return outcome;
  } finally {
    release();
  }
}

/** The outcome without the live engine and configuration handles a public caller never receives. */
export function runResult(outcome: RunOutcome): RunResult {
  const { exitCode, status, report, reportPath, aiTracePath } = outcome;
  return { exitCode, status, report, reportPath, aiTracePath };
}

/** 动态 Run 使用固定的文件配置与目标；Worker 数由配置决定，`maxWorkers` 只能压低上限。 */
export type DynamicRunOptions = Pick<SuiteRunOptions, 'cwd' | 'interruptSignal' | 'onEvent'> & {
  readonly config?: string;
  readonly target: string;
  /** Workers this run may start at once; the project's `workers` is capped by it. */
  readonly maxWorkers?: number;
  /** The run's output directory; the gateway gives every temporary Runner its own. */
  readonly output?: string;
};

/** 持有同一次执行，直到封口、排空和清理全部结束。 */
export interface DynamicRun {
  readonly runId: string;
  readonly result: Promise<RunResult>;
  submit(options: DynamicSubmitOptions): Promise<DynamicSubmission>;
  seal(): Promise<void>;
}

/** 创建按需执行的动态 Run；空队列保持开放，seal 后才结束。 */
export function runDynamic(options: DynamicRunOptions): DynamicRun {
  if (typeof options.target !== 'string' || options.target.trim() === '' || (options.config !== undefined && typeof options.config !== 'string')) {
    throw new ConfigurationError('INVALID_ARGUMENT', 'a dynamic run needs a target and accepts a config file');
  }
  if (options.maxWorkers !== undefined && (!Number.isSafeInteger(options.maxWorkers) || options.maxWorkers < 1)) {
    throw new ConfigurationError('INVALID_ARGUMENT', 'a dynamic run needs maxWorkers as a positive integer');
  }
  const release = reserveSuiteRun();
  const input = new DynamicRunInput(uuidv7());
  const onEvent = options.onEvent === undefined ? undefined : AsyncResource.bind(options.onEvent);
  const result = withProcessOutput(processSecrets, async (output) => {
    const interrupt = ownedInterrupt(options.interruptSignal);
    try {
      return await execute({
        ...toSelectionRunOptions({ cwd: options.cwd, config: options.config }),
        ...(options.output === undefined ? {} : { output: options.output }),
        ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }),
        targetIds: [options.target],
        dynamicInput: input,
        quiet: true,
        processOutput: output,
        interruptSignal: interrupt.signal,
        onEvent,
      });
    } finally {
      input.stop();
      interrupt.dispose();
      release();
    }
  }).then(({ exitCode, status, report, reportPath, aiTracePath }) => ({ exitCode, status, report, reportPath, aiTracePath }));
  return { runId: input.runId, result, submit: (submission) => input.submit(submission), seal: async () => { input.seal(); } };
}

/** Caller cancellation enters the suite's async context before invoking its listeners. */
function ownedInterrupt(signal: AbortSignal | undefined): { signal: AbortSignal | undefined; dispose(): void } {
  if (signal === undefined) return { signal: undefined, dispose: () => undefined };
  const controller = new AbortController();
  const abort = AsyncResource.bind(() => controller.abort(signal.reason));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, dispose: () => signal.removeEventListener('abort', abort) };
}
