/**
 * Asynchronous test jobs for the HTTP gateway. A job is persisted before the
 * temporary Runner child is told about it, so a client that loses its
 * connection can still ask for the status and report of what it submitted.
 * One child serves every job of one RunKey; it is forked on the first job and
 * stops after an idle grace once nothing is left to run.
 *
 * The gateway never loads the project config: the child owns collection,
 * authentication, the app, and the workers. Every message from it is parsed
 * into the closed shapes in `run/dynamic-ipc.ts` before it changes a record.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../../internal/atomic-write.ts';
import { ConfigurationError, errorMessage, InfrastructureError, TestError } from '../../internal/errors.ts';
import { timestamp, uuidv7 } from '../../internal/ids.ts';
import { processSecrets } from '../../run/secrecy.ts';
import {
  filePath,
  jobIdText,
  MAX_IPC_FILES,
  parseHostMessage,
  parseIpcError,
  parseIpcResult,
  type GatewayMessage,
  type IpcError,
  type IpcJobPhase,
  type IpcResult,
} from '../../run/dynamic-ipc.ts';
import { childEnvironment, JOB_RETENTION_MS, MAX_QUEUED_JOBS_PER_RUN, type HttpMcpToken } from './config.ts';
import {
  listedArtifacts,
  preserveJobArtifacts,
  readJobArtifactIndex,
  readReportArtifacts,
  type JobArtifactListing,
  type StoredArtifact,
} from './job-artifacts.ts';

/** How long a job may wait for the Runner child to become ready. */
const STARTUP_TIMEOUT_MS = 30_000;
/** How long authentication may keep a job waiting before it is reported timed out. */
const AUTH_TIMEOUT_MS = 120_000;
/** The most one job may run before it is reported timed out. */
const JOB_TIMEOUT_MS = 15 * 60_000;
/** An empty run seals after this long, so one more submission can join it. */
const IDLE_GRACE_MS = 2_000;
/** How long a shutting-down gateway waits for a child before it is killed. */
const STOP_GRACE_MS = 20_000;
/** How long a run stopped by its own deadline may keep draining before `stop`. */
const ABORT_GRACE_MS = 5_000;
/** The most results one report returns, and their serialized size budget. */
const MAX_REPORT_RESULTS = 50;
const MAX_REPORT_BYTES = 256 * 1024;

const ACCOUNT = 'tester';

export type JobStatus =
  | 'queued'
  | 'collecting'
  | 'waiting_auth'
  | 'running'
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'interrupted'
  | 'infrastructure_error'
  | 'rejected';

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'passed',
  'failed',
  'timed_out',
  'interrupted',
  'infrastructure_error',
  'rejected',
]);

type FinishedStatus = 'passed' | 'failed' | 'timed_out' | 'interrupted' | 'infrastructure_error' | 'rejected';

/** What a client asks to run. */
export interface JobSubmission {
  readonly targetId: string;
  readonly testFiles: readonly string[];
  readonly idempotencyKey?: string | undefined;
}

export interface JobCounts {
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly timedOut: number;
  readonly interrupted: number;
}

export interface JobStatusView {
  readonly jobId: string;
  readonly runId: string;
  readonly targetId: string;
  readonly status: JobStatus;
  readonly testFiles: readonly string[];
  readonly idempotencyKey?: string;
  readonly counts: JobCounts;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acceptedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: IpcError;
}

export interface JobReportView extends JobStatusView {
  readonly results: readonly IpcResult[];
  readonly truncated: boolean;
}

/** One persisted job. Internal state; the views above are what tools return. */
interface JobRecord extends Omit<JobStatusView, 'idempotencyKey' | 'acceptedAt' | 'startedAt' | 'finishedAt' | 'error'> {
  readonly version: 1;
  readonly principal: string;
  readonly digest: string;
  readonly idempotencyKey?: string;
  readonly acceptedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: IpcError;
  readonly resultIds: readonly string[];
  readonly results: readonly IpcResult[];
}

interface JobServiceOptions {
  readonly cwd: string;
  readonly configPath?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** Workers one run may start; the project config's `workers` is capped by it. */
  readonly maxWorkers: number;
  /** Runs alive at once; a new RunKey is refused past it. */
  readonly maxRuns: number;
  /** How long one run may stay alive; tests inject a short value. */
  readonly runTimeoutMs: number;
  /** How long one job may run; tests inject a short value. */
  readonly jobTimeoutMs?: number | undefined;
  /** How long one job may wait for authentication; tests inject a short value. */
  readonly authTimeoutMs?: number | undefined;
  /** How long a finished job stays readable; tests inject a short value. */
  readonly retentionMs?: number | undefined;
  /** How long a Runner child may take to become ready; tests inject a short value. */
  readonly startupTimeoutMs?: number | undefined;
  readonly log: (line: string) => void;
}

/** Serves the four job tools and the artifact download route. */
export class JobService {
  private readonly records = new Map<string, JobRecord>();
  private readonly idempotent = new Map<string, string>();
  private readonly runs = new Map<string, RunChannel>();
  /** Every live child, including one a newer run for the same key replaced. */
  private readonly active = new Set<RunChannel>();
  /** RunKeys whose child is still being forked; they count against `maxRuns`. */
  private readonly starting = new Set<string>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly jobsDir: string;
  private readonly runsDir: string;
  private readonly artifactsDir: string;
  /** Jobs whose run ended and whose artifact copy has not settled yet. */
  private readonly pendingArtifacts = new Set<string>();
  private readonly preservations = new Set<Promise<void>>();
  /** Read by a run's channel when it arms a job's timers. */
  readonly jobTimeoutMs: number;
  readonly authTimeoutMs: number;
  readonly startupTimeoutMs: number;
  private readonly retentionMs: number;
  private sweeper: NodeJS.Timeout | undefined;
  private closing = false;

  private constructor(private readonly options: JobServiceOptions, dirs: { jobs: string; runs: string; artifacts: string }) {
    this.jobsDir = dirs.jobs;
    this.runsDir = dirs.runs;
    this.artifactsDir = dirs.artifacts;
    this.jobTimeoutMs = options.jobTimeoutMs ?? JOB_TIMEOUT_MS;
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.retentionMs = options.retentionMs ?? JOB_RETENTION_MS;
  }

  static async create(options: JobServiceOptions): Promise<JobService> {
    const root = await realpath(options.cwd);
    const jobs = path.join(root, '.e2e', 'http-jobs');
    const runs = path.join(jobs, 'runs');
    const artifacts = path.join(jobs, 'artifacts');
    await mkdir(runs, { recursive: true, mode: 0o700 });
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    // A link anywhere in the record path would write outside the project.
    for (const dir of [path.join(root, '.e2e'), jobs, runs, artifacts]) {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ConfigurationError('INVALID_ARGUMENT', `the job directory ${dir} is not a real directory`);
      }
    }
    // A gateway killed before it could stop a run leaves that run's output,
    // including its session snapshot, behind; one gateway owns this project.
    for (const entry of await readdir(runs)) {
      await rm(path.join(runs, entry), { recursive: true, force: true }).catch((cause: unknown) => {
        options.log(`http-jobs: could not remove a stale run directory: ${processSecrets.redact(errorMessage(cause))}`);
      });
    }
    const service = new JobService(options, { jobs, runs, artifacts });
    await service.load();
    // A crash can leave an artifact copy no record names; the first sweep takes
    // it out along with expired records.
    await service.sweep();
    // One sweep an hour, or sooner when a test injects a short retention.
    service.sweeper = setInterval(
      () => void service.sweep(),
      Math.max(10, Math.min(service.retentionMs, 60 * 60_000)),
    );
    service.sweeper.unref();
    return service;
  }

  /** Accepts one submission; a repeated idempotency key returns the original job. */
  async submit(token: HttpMcpToken, input: JobSubmission): Promise<JobStatusView> {
    if (this.closing) throw new ConfigurationError('INVALID_ARGUMENT', 'the gateway is shutting down');
    const targetId = bounded(input.targetId, 200, 'targetId');
    if (!Array.isArray(input.testFiles) || input.testFiles.length === 0 || input.testFiles.length > MAX_IPC_FILES) {
      throw invalid(`testFiles must list 1 to ${MAX_IPC_FILES} project-relative files`);
    }
    const testFiles = input.testFiles.map((file) => filePath(String(file).replaceAll('\\', '/')));
    const files = testFiles.filter((file): file is string => file !== undefined);
    if (files.length !== testFiles.length) {
      throw invalid('testFiles must be project-relative paths without traversal or control characters');
    }
    const idempotencyKey = input.idempotencyKey === undefined ? undefined : bounded(input.idempotencyKey, 200, 'idempotencyKey');
    const digest = digestOf(targetId, files);
    const scope = `${token.principal}\u0000${targetId}\u0000${idempotencyKey ?? ''}`;
    // The lookup is inside the RunKey's chain so two concurrent submissions
    // with one key collapse into the first job instead of racing.
    return this.exclusive(this.runKey(targetId), async () => {
      if (this.closing) throw new ConfigurationError('INVALID_ARGUMENT', 'the gateway is shutting down');
      if (idempotencyKey !== undefined) {
        const existing = this.idempotent.get(scope);
        const job = existing === undefined ? undefined : this.records.get(existing);
        if (job !== undefined && job.digest !== digest) {
          throw invalid('the idempotency key was already used with a different request');
        }
        if (job !== undefined) return view(job);
      }
      let run = await this.ensureRun(targetId);
      // The gateway can start closing while the child is forked.
      if (this.closing) {
        void run.stop(STOP_GRACE_MS);
        throw new ConfigurationError('INVALID_ARGUMENT', 'the gateway is shutting down');
      }
      if (run.sealed || run.finished) {
        throw new InfrastructureError('WORKER_EXIT', 'the run ended before the submission reached it; run_test again');
      }
      if (run.jobs.size >= MAX_QUEUED_JOBS_PER_RUN) {
        // A run that was created for this submission has nothing queued yet,
        // so the refusal never strands a fresh child; the idle grace ends it.
        run.maybeSeal();
        throw new ConfigurationError(
          'CAPACITY_EXCEEDED',
          `the run already holds ${MAX_QUEUED_JOBS_PER_RUN} unfinished jobs; wait for one to finish before submitting another`,
        );
      }
      const jobId = uuidv7();
      const now = timestamp();
      const record: JobRecord = {
        version: 1,
        jobId,
        runId: run.runId,
        principal: token.principal,
        targetId,
        status: 'queued',
        testFiles: files,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        digest,
        resultIds: [],
        results: [],
        counts: countsOf([], 0),
        createdAt: now,
        updatedAt: now,
      };
      // Persisted before the child hears about it: a crash leaves a queued
      // record, never a job that ran without one.
      try {
        await writeFileAtomic(this.jobFile(jobId), JSON.stringify(record), { mode: 0o600 });
      } catch (cause) {
        // The child was forked for this job and now has none; let it idle out.
        run.maybeSeal();
        throw cause;
      }
      // The idle grace can seal the run while the record is written; the
      // sealed run is empty, so the submission joins a fresh one instead.
      if (run.sealed || run.finished) {
        try {
          run = await this.ensureRun(targetId);
        } catch (cause) {
          // The record never entered `records`; without this the file would be
          // restored as an interrupted job that was never submitted.
          await rm(this.jobFile(jobId), { force: true }).catch(() => undefined);
          throw cause;
        }
        this.update(record, { runId: run.runId });
      }
      this.records.set(jobId, record);
      if (idempotencyKey !== undefined) this.idempotent.set(scope, jobId);
      if (run.jobs.size === 0) run.originJobId = jobId;
      run.jobs.add(jobId);
      run.clearIdle();
      // Collection runs project code before the child accepts; the deadline
      // covers it, so a submission that hangs cannot hold the run forever.
      run.armSubmission(jobId);
      this.update(record, { status: 'collecting' });
      run.send({ v: 1, type: 'submit', jobId, files });
      return view(record);
    });
  }

  /** One job's current status, for the principal that submitted it. */
  status(token: HttpMcpToken, jobId: string): JobStatusView {
    return view(this.owned(token, jobId));
  }

  /** One job's report: its results, bounded failure summary, and no disk paths. */
  report(token: HttpMcpToken, jobId: string): JobReportView {
    const record = this.owned(token, jobId);
    const results: IpcResult[] = [];
    let bytes = 0;
    for (const result of record.results) {
      const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (results.length >= MAX_REPORT_RESULTS || bytes + size > MAX_REPORT_BYTES) break;
      results.push(result);
      bytes += size;
    }
    return { ...view(record), results, truncated: results.length < record.results.length };
  }

  /**
   * One job's kept artifacts. A finished job whose run is still alive has no
   * index yet, so `ready` stays false until the run ends and the copy lands.
   */
  async artifacts(token: HttpMcpToken, jobId: string, baseUrl: string): Promise<JobArtifactListing> {
    const record = this.owned(token, jobId);
    const index = await readJobArtifactIndex(this.jobArtifactIndex(record.jobId));
    if (index !== undefined && index.jobId === record.jobId) return listedArtifacts(index, baseUrl);
    if (!TERMINAL.has(record.status) || this.pendingArtifacts.has(record.jobId) || this.runFor(record) !== undefined) {
      return { jobId: record.jobId, ready: false, artifacts: [], truncated: false };
    }
    // The run ended before this gateway could keep its files, or the copy
    // failed; the client must not poll forever.
    return { jobId: record.jobId, ready: true, artifacts: [], truncated: false, error: 'artifacts_unavailable' };
  }

  /** One stored artifact for the download route; undefined for a job the token does not own. */
  async artifactFile(token: HttpMcpToken, jobId: string, index: number): Promise<StoredArtifact | undefined> {
    // The id becomes a file name below, so it must be one a record can carry.
    const id = jobIdText(jobId);
    if (id === undefined || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return undefined;
    const record = this.records.get(id);
    if (record === undefined || record.principal !== token.principal) return undefined;
    const listing = await readJobArtifactIndex(this.jobArtifactIndex(id));
    const artifact = listing?.jobId === id ? listing.artifacts[index] : undefined;
    if (artifact?.file === undefined) return undefined;
    const file = path.join(this.jobArtifactDir(id), artifact.file);
    const info = await lstat(file).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink() || !info.isFile()) return undefined;
    return { path: file, mediaType: artifact.mediaType, fileName: artifact.fileName, size: info.size };
  }

  /** Seals every run, waits for its child, and marks what it cut as interrupted. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.sweeper !== undefined) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    // A submission already past its closing check may still be forking a run;
    // wait for every chain to settle before draining, so none is created after.
    await Promise.allSettled(this.chains.values());
    // `active`, not `runs`: a sealed child replaced by a newer run for the same
    // key left the routing map but still owns workers and a login.
    // Deleting the current run while iterating a Set is safe; the exit handler
    // may delete others, which only skips work already done for them.
    for (const run of this.active) {
      run.beginShutdown();
      await run.stop(STOP_GRACE_MS);
      // A child the OS will not reap must not keep the gateway shutting down;
      // its jobs are cut here whether or not its exit event ever arrives.
      this.active.delete(run);
      if (this.runs.get(run.key) === run) this.runs.delete(run.key);
      for (const jobId of run.jobs) {
        const record = this.records.get(jobId);
        if (record === undefined || TERMINAL.has(record.status)) continue;
        this.finish(record, 'interrupted', {
          code: 'INTERRUPTED',
          category: 'interrupted',
          message: 'the gateway shut down before the job finished',
          phase: 'run',
        });
      }
      run.jobs.clear();
    }
    // A run stopped just now may be copying its artifacts; keep them too.
    while (this.preservations.size > 0) await Promise.allSettled(this.preservations);
    await this.drainWrites();
  }

  /** Called by a run's auth timer; aborting the run is the only way to stop a waiting login. */
  readonly authTimedOut = (jobId: string): void => {
    const record = this.records.get(jobId);
    if (record === undefined || TERMINAL.has(record.status)) return;
    const run = this.runFor(record);
    run?.clearTimers(jobId);
    this.finish(
      record,
      'timed_out',
      deadlineError('AUTH_TIMEOUT', `the job waited ${formatDuration(this.authTimeoutMs)} for authentication; the run was stopped`, 'auth'),
    );
    if (run === undefined) return;
    run.jobs.delete(jobId);
    run.abort();
  };

  /** Called by a job's timer; a run left with no other job is stopped with it. */
  readonly jobTimedOut = (jobId: string): void => {
    const record = this.records.get(jobId);
    if (record === undefined || TERMINAL.has(record.status)) return;
    // Collection is serialized in the child: a job stuck there blocks every
    // later submission, so the run is aborted even if other jobs are queued.
    const collecting = record.status === 'queued' || record.status === 'collecting';
    const run = this.runFor(record);
    run?.clearTimers(jobId);
    const stopsRun = collecting || run === undefined || run.jobs.size <= 1;
    const tail = run === undefined ? 'the run had already ended' : stopsRun ? 'the run was stopped' : 'the run continues';
    this.finish(
      record,
      'timed_out',
      deadlineError(
        'JOB_TIMEOUT',
        `the job did not finish within ${formatDuration(this.jobTimeoutMs)}${collecting ? ' of collection' : ''}; ${tail}`,
        collecting ? 'collection' : 'run',
      ),
    );
    if (run === undefined) return;
    run.jobs.delete(jobId);
    if (collecting || run.jobs.size === 0) run.abort();
  };

  /** Called by a run's deadline; every job it still serves ends `timed_out`. */
  readonly runTimedOut = (run: RunChannel): void => {
    if (run.finished || run.disposed || run.deadlineExceeded) return;
    run.deadlineExceeded = true;
    for (const jobId of run.jobs) {
      const record = this.records.get(jobId);
      if (record !== undefined && !TERMINAL.has(record.status)) {
        this.finish(record, 'timed_out', runDeadlineError(this.options.runTimeoutMs));
      }
      run.clearTimers(jobId);
    }
    run.jobs.clear();
    run.abort();
  };

  /** A child that exits without a `run-finished` leaves its jobs unfinished. */
  readonly handleExit = (run: RunChannel, code: number | null, signal: NodeJS.Signals | null): void => {
    run.dispose();
    if (!run.finished) {
      run.finished = true;
      for (const jobId of run.jobs) {
        const record = this.records.get(jobId);
        if (record === undefined || TERMINAL.has(record.status)) continue;
        if (run.deadlineExceeded) {
          this.finish(record, 'timed_out', runDeadlineError(this.options.runTimeoutMs));
          continue;
        }
        const ended = signal !== null ? `with ${signal}` : code !== null ? `with ${String(code)}` : 'without reporting a status';
        this.finish(record, this.closing ? 'interrupted' : 'infrastructure_error', {
          code: this.closing ? 'INTERRUPTED' : 'WORKER_EXIT',
          category: this.closing ? 'interrupted' : 'infrastructure',
          message: `the Runner exited ${ended} before the job finished`,
          phase: 'run',
        });
      }
      run.jobs.clear();
    }
    if (this.runs.get(run.key) === run) this.runs.delete(run.key);
    this.active.delete(run);
    // Both `exit` and `disconnect` land here; the first one owns the handoff.
    if (run.outputHandled) return;
    run.outputHandled = true;
    this.preserveRun(run);
  };

  /** Keeps every job's artifacts, then removes the run output that held them. */
  private preserveRun(run: RunChannel): void {
    const records = [...this.records.values()].filter((record) => record.runId === run.runId);
    for (const record of records) this.pendingArtifacts.add(record.jobId);
    const done = (async () => {
      try {
        const report = await readReportArtifacts(run.output);
        for (const record of records) {
          try {
            await preserveJobArtifacts({
              jobId: record.jobId,
              resultIds: record.resultIds,
              report,
              output: run.output,
              dir: this.jobArtifactDir(record.jobId),
              indexFile: this.jobArtifactIndex(record.jobId),
            });
          } catch (cause) {
            this.options.log(`job ${record.jobId}: could not keep its artifacts: ${processSecrets.redact(errorMessage(cause))}`);
          }
        }
      } finally {
        for (const record of records) this.pendingArtifacts.delete(record.jobId);
        // Nothing reads a finished run's output again; leaving the directory
        // would grow without bound.
        await rm(run.output, { recursive: true, force: true }).catch((cause: unknown) => {
          this.options.log(`job run ${run.runId}: could not remove output: ${processSecrets.redact(errorMessage(cause))}`);
        });
      }
    })();
    this.preservations.add(done);
    void done.finally(() => this.preservations.delete(done));
  }

  /** Routes one parsed child message to the job it names. */
  readonly handleMessage = (run: RunChannel, message: NonNullable<ReturnType<typeof parseHostMessage>>): void => {
    if (message.type === 'ready' || message.type === 'run-finished') return;
    if (message.type === 'run-error') {
      run.runError ??= message.error;
      return;
    }
    const record = this.records.get(message.jobId);
    if (record === undefined || TERMINAL.has(record.status)) return;
    // A message may only speak for a job of the run that sent it.
    if (record.runId !== run.runId) return;
    switch (message.type) {
      case 'accepted':
        this.update(record, {
          status: 'waiting_auth',
          acceptedAt: timestamp(),
          resultIds: message.resultIds,
          counts: countsOf([], message.resultIds.length),
        });
        if (message.awaitingAuth) run.armAuth(record.jobId);
        break;
      case 'phase':
        if (message.phase === 'running') {
          run.clearAuthTimer(record.jobId);
          this.update(record, {
            status: 'running',
            ...(message.started === true && record.startedAt === undefined ? { startedAt: timestamp() } : {}),
          });
        } else {
          this.update(record, { status: 'waiting_auth' });
        }
        break;
      case 'rejected':
        run.clearTimers(record.jobId);
        this.finish(record, 'rejected', message.error);
        run.jobs.delete(record.jobId);
        run.maybeSeal();
        break;
      case 'result': {
        const results = [...record.results, message.result];
        this.update(record, {
          status: 'running',
          results,
          counts: countsOf(results, record.resultIds.length),
          ...(record.startedAt === undefined ? { startedAt: timestamp() } : {}),
        });
        if (record.resultIds.length > 0 && results.length >= record.resultIds.length) {
          run.clearTimers(record.jobId);
          const allSkipped = results.every((entry) => entry.status === 'skipped');
          const authFailure =
            run.runError?.phase === 'auth' && (allSkipped || results.some((entry) => entry.skipCause === 'setup-failed'))
              ? run.runError
              : undefined;
          const status = terminalStatus(results, authFailure, run.runError);
          this.finish(record, status, terminalError(status, authFailure, run.runError));
          run.finishedJobs.add(record.jobId);
          run.jobs.delete(record.jobId);
          run.maybeSeal();
        }
        break;
      }
    }
  };

  /** `run-finished` from the child: whatever is left did not get its results. */
  readonly handleRunFinished = (run: RunChannel, status: string, exitCode: number, error: IpcError | undefined): void => {
    run.finished = true;
    // A hook error is reported with the unit's completion, after its results;
    // a job that already reported `passed` must not stay a pass.
    if (error?.code === 'HOOK_FAILED') {
      for (const jobId of run.finishedJobs) {
        const record = this.records.get(jobId);
        if (record === undefined) continue;
        if (record.status === 'passed' || (record.status === 'failed' && record.error === undefined)) {
          this.finish(record, 'failed', error);
        }
      }
    }
    for (const jobId of run.jobs) {
      const record = this.records.get(jobId);
      if (record === undefined || TERMINAL.has(record.status)) continue;
      if (run.deadlineExceeded) {
        this.finish(record, 'timed_out', runDeadlineError(this.options.runTimeoutMs));
      } else if (record.acceptedAt === undefined) {
        if (this.closing) {
          this.finish(record, 'interrupted', {
            code: 'INTERRUPTED',
            category: 'interrupted',
            message: 'the gateway shut down before the job was accepted',
            phase: 'collection',
          });
        } else if (run.originJobId === record.jobId && error !== undefined) {
          // The job that started this run owns a start-up failure such as an
          // unknown target; later jobs must not inherit another job's error.
          this.finish(record, 'infrastructure_error', error);
        } else {
          const rejection = new ConfigurationError(
            'INVALID_ARGUMENT',
            'the run ended before this job was accepted; submit it again',
          );
          this.finish(record, 'rejected', {
            code: rejection.code,
            category: rejection.category,
            message: rejection.message,
            phase: 'collection',
          });
        }
      } else if (error?.phase === 'auth') {
        this.finish(record, 'failed', error);
      } else if (exitCode === 130) {
        this.finish(record, 'interrupted', {
          code: 'INTERRUPTED',
          category: 'interrupted',
          message: `the run was interrupted (${status})`,
          phase: 'run',
        });
      } else {
        this.finish(
          record,
          'infrastructure_error',
          error ?? {
            code: 'WORKER_EXIT',
            category: 'infrastructure',
            message: `the run ended with ${status} (exit ${exitCode}) before the job finished`,
            phase: 'run',
          },
        );
      }
    }
    run.jobs.clear();
    run.finishedJobs.clear();
    run.dispose();
    // A test can leave a timer behind, so `run-finished` does not guarantee the
    // child exits; a slot that still counts as live would never be released.
    void run.stop(STOP_GRACE_MS);
  };

  private finish(record: JobRecord, status: FinishedStatus, error?: IpcError): void {
    this.update(record, { status, finishedAt: timestamp(), ...(error === undefined ? {} : { error }) });
  }

  private update(record: JobRecord, patch: Partial<JobRecord>): void {
    Object.assign(record, patch, { updatedAt: timestamp() });
    this.persist(record);
  }

  private persist(record: JobRecord): void {
    // One write in flight per job: results arrive in bursts, and every write
    // carries the whole record, so a queued update only needs one follow-up.
    if (this.writes.has(record.jobId)) {
      this.dirty.add(record.jobId);
      return;
    }
    this.writeRecord(record);
  }

  private writeRecord(record: JobRecord): void {
    const next = writeFileAtomic(this.jobFile(record.jobId), JSON.stringify(record), { mode: 0o600 }).catch(
      (cause: unknown) => {
        this.options.log(`job ${record.jobId}: could not persist: ${processSecrets.redact(errorMessage(cause))}`);
      },
    );
    this.writes.set(record.jobId, next);
    void next.finally(() => {
      if (this.writes.get(record.jobId) !== next) return;
      this.writes.delete(record.jobId);
      if (this.dirty.delete(record.jobId)) this.writeRecord(record);
    });
  }

  private async drainWrites(): Promise<void> {
    while (this.writes.size > 0) await Promise.all(this.writes.values());
  }

  private owned(token: HttpMcpToken, jobId: string): JobRecord {
    const id = jobIdText(jobId);
    if (id === undefined) throw invalid('jobId must be a non-empty identifier');
    const record = this.records.get(id);
    if (record === undefined) throw new ConfigurationError('INVALID_ARGUMENT', `job "${id}" does not exist`);
    if (record.principal !== token.principal) {
      throw new ConfigurationError('POLICY_DENIED', `job "${id}" belongs to another client`);
    }
    return record;
  }

  private runFor(record: JobRecord): RunChannel | undefined {
    const run = this.runs.get(this.runKey(record.targetId));
    return run?.runId === record.runId ? run : undefined;
  }

  /** One child per RunKey, forked on the first job and stopped after the idle grace. */
  private async ensureRun(targetId: string): Promise<RunChannel> {
    if (this.closing) throw new ConfigurationError('INVALID_ARGUMENT', 'the gateway is shutting down');
    const key = this.runKey(targetId);
    const existing = this.runs.get(key);
    if (existing !== undefined && !existing.sealed && !existing.finished) return existing;
    if (existing !== undefined) {
      // A sealed child still holds its engine and login; wait for it to exit
      // so the successor never runs a second login on the same target.
      await existing.retire();
      if (this.runs.get(key) === existing) this.runs.delete(key);
      this.active.delete(existing);
    }
    if (this.closing) throw new ConfigurationError('INVALID_ARGUMENT', 'the gateway is shutting down');
    // A child another RunKey left sealed still counts against the limit until
    // its exit handler removes it. `starting` closes the window between this
    // check and `runs.set`, which another submission could cross while forking.
    if (this.liveRuns() + this.starting.size >= this.options.maxRuns) {
      throw new ConfigurationError(
        'CAPACITY_EXCEEDED',
        `the gateway already serves ${this.options.maxRuns} test runs; wait for one to finish before submitting to "${targetId}" again`,
      );
    }
    this.starting.add(key);
    const output = path.join(this.runsDir, randomUUID());
    try {
      const run = await RunChannel.start({
        key,
        cwd: this.options.cwd,
        ...(this.options.configPath === undefined ? {} : { configPath: this.options.configPath }),
        targetId,
        output,
        maxWorkers: this.options.maxWorkers,
        startupTimeoutMs: this.startupTimeoutMs,
        runTimeoutMs: this.options.runTimeoutMs,
        env: this.options.env,
        log: this.options.log,
        service: this,
      });
      this.runs.set(key, run);
      this.active.add(run);
      return run;
    } catch (cause) {
      // No channel will clean up a child that never became ready.
      await rm(output, { recursive: true, force: true }).catch(() => undefined);
      throw cause;
    } finally {
      this.starting.delete(key);
    }
  }

  /** Children that still count against `maxRuns`; a finished run is releasing. */
  private liveRuns(): number {
    let count = 0;
    for (const run of this.active) if (!run.finished) count += 1;
    return count;
  }

  /**
   * Removes finished records past their retention and any artifact file no
   * record names; a live job is never swept. The artifact scan also clears a
   * copy a crash left without an index.
   */
  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.retentionMs;
    for (const record of this.records.values()) {
      if (record.finishedAt === undefined || !TERMINAL.has(record.status)) continue;
      if (Date.parse(record.finishedAt) > cutoff || this.writes.has(record.jobId)) continue;
      this.records.delete(record.jobId);
      if (record.idempotencyKey !== undefined) {
        this.idempotent.delete(`${record.principal}\u0000${record.targetId}\u0000${record.idempotencyKey}`);
      }
      void rm(this.jobFile(record.jobId), { force: true }).catch(() => undefined);
    }
    const entries = await readdir(this.artifactsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const jobId = entry.isDirectory()
        ? entry.name
        : entry.isFile() && entry.name.endsWith('.json')
          ? entry.name.slice(0, -'.json'.length)
          : undefined;
      if (jobId === undefined || this.records.has(jobId) || this.pendingArtifacts.has(jobId)) continue;
      await rm(path.join(this.artifactsDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private runKey(targetId: string): string {
    return `${path.resolve(this.options.cwd)}\u0000${this.options.configPath ?? ''}\u0000${targetId}\u0000${ACCOUNT}`;
  }

  private jobFile(jobId: string): string {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  private jobArtifactDir(jobId: string): string {
    return path.join(this.artifactsDir, jobId);
  }

  private jobArtifactIndex(jobId: string): string {
    return path.join(this.artifactsDir, `${jobId}.json`);
  }

  /** Serializes submissions and run creation for one RunKey. */
  private exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(action, action);
    const tail = next.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  /** Restores jobs from disk; one a previous gateway left unfinished is interrupted. */
  private async load(): Promise<void> {
    const entries = await readdir(this.jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.jobsDir, entry.name);
      let record: JobRecord | undefined;
      try {
        const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        record = parseRecord(JSON.parse(await readFile(file, 'utf8')));
      } catch {
        continue;
      }
      if (record === undefined || `${record.jobId}.json` !== entry.name) continue;
      if (record.finishedAt !== undefined && Date.parse(record.finishedAt) < Date.now() - this.retentionMs) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      this.records.set(record.jobId, record);
      if (record.idempotencyKey !== undefined) {
        this.idempotent.set(`${record.principal}\u0000${record.targetId}\u0000${record.idempotencyKey}`, record.jobId);
      }
      if (!TERMINAL.has(record.status)) {
        this.finish(record, 'interrupted', {
          code: 'INTERRUPTED',
          category: 'interrupted',
          message: 'the gateway restarted before the job finished',
          phase: 'run',
        });
      }
    }
    await this.drainWrites();
  }
}

/** One forked Runner child and the jobs it serves. */
class RunChannel {
  /** Set once `seal` is sent; no submission may join this run afterwards. */
  sealed = false;
  finished = false;
  /** Set when the run's own deadline stopped it; its jobs end `timed_out`. */
  deadlineExceeded = false;
  runError: IpcError | undefined;
  /** The submission that started the run; a start-up failure belongs to it. */
  originJobId: string | undefined;
  /** Set once the exit handler has handed the output to the artifact store. */
  outputHandled = false;
  readonly jobs = new Set<string>();
  /** Jobs that finished with results; a late hook error can still fail them. */
  readonly finishedJobs = new Set<string>();
  private readonly authTimers = new Map<string, NodeJS.Timeout>();
  private readonly jobTimers = new Map<string, NodeJS.Timeout>();
  private idleTimer: NodeJS.Timeout | undefined;
  private runTimer: NodeJS.Timeout | undefined;
  disposed = false;
  private readonly exit: Promise<void>;

  private constructor(
    readonly key: string,
    readonly runId: string,
    readonly output: string,
    private readonly child: ChildProcess,
    private readonly service: JobService,
    private readonly runTimeoutMs: number,
    private readonly log: (line: string) => void,
  ) {
    this.exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }

  /** Forks the child and waits for its `ready`; a child that never answers is killed. */
  static async start(options: {
    key: string;
    cwd: string;
    configPath?: string;
    targetId: string;
    output: string;
    maxWorkers: number;
    startupTimeoutMs: number;
    runTimeoutMs: number;
    env: NodeJS.ProcessEnv;
    log: (line: string) => void;
    service: JobService;
  }): Promise<RunChannel> {
    const entry = new URL('../../run/dynamic-host.js', import.meta.url);
    const args = ['--cwd', options.cwd, '--target', options.targetId, '--output', options.output, '--max-workers', String(options.maxWorkers)];
    if (options.configPath !== undefined) args.push('--config', options.configPath);
    const child = fork(entry, args, {
      cwd: options.cwd,
      env: childEnvironment(options.env),
      execArgv: [],
      silent: true,
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text !== '') options.log(`job runner: ${processSecrets.redact(text)}`);
    });
    child.stdout?.on('data', () => undefined);
    const runId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new InfrastructureError('WORKER_INIT_FAILED', `the Runner did not start within ${formatDuration(options.startupTimeoutMs)}`));
      }, options.startupTimeoutMs);
      timer.unref();
      const onMessage = (raw: unknown): void => {
        const message = parseHostMessage(raw);
        if (message?.type !== 'ready') return;
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('error', onError);
        resolve(message.runId);
      };
      // A spawn or channel failure must settle readiness, not crash the gateway.
      const onError = (error: Error): void => {
        clearTimeout(timer);
        child.off('message', onMessage);
        reject(new InfrastructureError('WORKER_INIT_FAILED', `the Runner failed to start: ${error.message}`));
      };
      child.on('message', onMessage);
      child.once('error', onError);
      child.once('exit', (code) => {
        clearTimeout(timer);
        child.off('error', onError);
        reject(new InfrastructureError('WORKER_INIT_FAILED', `the Runner exited with ${String(code)} before it was ready`));
      });
    });
    const run = new RunChannel(options.key, runId, options.output, child, options.service, options.runTimeoutMs, options.log);
    run.armRunDeadline();
    child.on('error', (error: Error) => options.log(`job runner: ${processSecrets.redact(error.message)}`));
    child.on('message', (raw: unknown) => {
      const message = parseHostMessage(raw);
      if (message === undefined) {
        options.log('job runner: ignored a message that did not parse');
        return;
      }
      if (message.type === 'run-finished') {
        options.service.handleRunFinished(run, message.status, message.exitCode, message.error);
        return;
      }
      options.service.handleMessage(run, message);
    });
    child.once('exit', (code, signal) => {
      options.service.handleExit(run, code, signal);
    });
    // The child closes its side of the channel as it leaves, so a `run-finished`
    // it sent is dispatched before this; anything still open lost its runner
    // and must not wait for an exit event that may never come.
    child.once('disconnect', () => {
      options.service.handleExit(run, null, null);
      // A child that closed the channel may still be running project code.
      void run.stop(ABORT_GRACE_MS);
    });
    return run;
  }

  send(message: GatewayMessage): void {
    if (this.child.connected === false) return;
    try {
      // The callback takes the channel error, which an unhandled `error`
      // event would otherwise turn into a gateway-wide failure.
      this.child.send(message, (error) => {
        if (error !== null) this.log(`job runner: could not send: ${processSecrets.redact(error.message)}`);
      });
    } catch {
      // The exit handler is the only place that cleans up after a dead child.
    }
  }

  /** Sends `seal` once; the run drains its queue and ends. */
  seal(): void {
    if (this.sealed || this.finished || this.disposed) return;
    this.sealed = true;
    this.send({ v: 1, type: 'seal' });
  }

  /** Stops an authentication wait or a job that outlived its deadline. */
  abort(): void {
    // A stop message is not enough: project code can block the child's event
    // loop, so the escalation to SIGKILL has to run on the gateway's side.
    // The grace is shorter than a normal shutdown: a timed-out job has already
    // been reported, and letting its test finish would add side effects.
    void this.stop(ABORT_GRACE_MS);
  }

  /** Starts the idle grace that seals a run with no work left. */
  maybeSeal(): void {
    if (this.sealed || this.finished || this.disposed || this.jobs.size > 0 || this.idleTimer !== undefined) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.jobs.size === 0) this.seal();
    }, IDLE_GRACE_MS);
    this.idleTimer.unref();
  }

  clearIdle(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** The job's whole deadline, armed when it is queued and never reset. */
  armSubmission(jobId: string): void {
    if (this.jobTimers.has(jobId)) return;
    const job = setTimeout(() => this.service.jobTimedOut(jobId), this.service.jobTimeoutMs);
    job.unref();
    this.jobTimers.set(jobId, job);
  }

  /** The whole run's deadline, armed once it is ready and never reset. */
  private armRunDeadline(): void {
    this.runTimer = setTimeout(() => this.service.runTimedOut(this), this.runTimeoutMs);
    this.runTimer.unref();
  }

  /** Waits for a sealed or finished child to exit, killing it after the grace. */
  async retire(): Promise<void> {
    await this.stop(STOP_GRACE_MS);
    // A child the OS will not reap must not hold this RunKey's chain forever.
    await Promise.race([this.exit, delay(5_000)]);
  }

  /** The authentication wait starts once the child has accepted the job. */
  armAuth(jobId: string): void {
    this.clearAuthTimer(jobId);
    const auth = setTimeout(() => this.service.authTimedOut(jobId), this.service.authTimeoutMs);
    auth.unref();
    this.authTimers.set(jobId, auth);
  }

  clearAuthTimer(jobId: string): void {
    const timer = this.authTimers.get(jobId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.authTimers.delete(jobId);
  }

  clearTimers(jobId: string): void {
    this.clearAuthTimer(jobId);
    const timer = this.jobTimers.get(jobId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.jobTimers.delete(jobId);
  }

  beginShutdown(): void {
    this.clearIdle();
  }

  /** Seals, waits for the child, then kills it; the exit handler marks what was cut. */
  async stop(graceMs: number): Promise<void> {
    this.seal();
    const exited = await Promise.race([this.exit.then(() => true), delay(graceMs).then(() => false)]);
    if (exited) return;
    this.send({ v: 1, type: 'stop' });
    const stopped = await Promise.race([this.exit.then(() => true), delay(5_000).then(() => false)]);
    if (!stopped) this.child.kill('SIGKILL');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdle();
    if (this.runTimer !== undefined) {
      clearTimeout(this.runTimer);
      this.runTimer = undefined;
    }
    for (const jobId of [...this.authTimers.keys(), ...this.jobTimers.keys()]) this.clearTimers(jobId);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function terminalStatus(
  results: readonly IpcResult[],
  authFailure: IpcError | undefined,
  runError: IpcError | undefined,
): FinishedStatus {
  if (results.some((result) => result.status === 'interrupted')) return 'interrupted';
  if (results.some((result) => result.status === 'timed-out')) return 'timed_out';
  if (results.some((result) => result.status === 'failed')) return 'failed';
  // Every test skipped because the shared authentication failed is not a pass.
  if (authFailure !== undefined) return 'failed';
  const causes = new Set(results.flatMap((result) => (result.skipCause === undefined ? [] : [result.skipCause])));
  // A test the runner never started is not a pass, even when its neighbours did.
  if (causes.has('infrastructure-unavailable')) {
    return runError === undefined || runError.code === 'CANCELLED' ? 'interrupted' : 'infrastructure_error';
  }
  if (causes.has('hook-failed') || causes.has('serial-predecessor-failed') || causes.has('setup-failed')) {
    return 'failed';
  }
  if (causes.has('time-limit')) return 'timed_out';
  if (causes.has('failure-limit')) return 'interrupted';
  return 'passed';
}

/** The run-level error a terminal status carries, when one explains it. */
/** One deadline, as the runner's test-category error with its phase. */
function deadlineError(code: 'AUTH_TIMEOUT' | 'JOB_TIMEOUT' | 'RUN_TIMEOUT', message: string, phase: IpcJobPhase): IpcError {
  const error = new TestError(code, message, { retryable: true });
  return { code: error.code, category: error.category, message: error.message, phase, retryable: true };
}

/** The error every job still queued or running when the run's own clock ended carries. */
function runDeadlineError(timeoutMs: number): IpcError {
  return deadlineError('RUN_TIMEOUT', `the run reached its ${formatDuration(timeoutMs)} limit; the job did not finish`, 'run');
}

/** A deadline in the largest unit that keeps it a whole number. */
function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} ${ms === 60_000 ? 'minute' : 'minutes'}`;
  if (ms % 1_000 === 0) return `${ms / 1_000} ${ms === 1_000 ? 'second' : 'seconds'}`;
  return `${ms} ms`;
}

function terminalError(
  status: FinishedStatus,
  authFailure: IpcError | undefined,
  runError: IpcError | undefined,
): IpcError | undefined {
  // A test-category failure is its own; only a hook failure explains it.
  if (status === 'failed') return authFailure ?? (runError?.code === 'HOOK_FAILED' ? runError : undefined);
  if (status === 'infrastructure_error' || status === 'timed_out') return runError;
  if (status === 'interrupted') {
    return (
      runError ?? {
        code: 'INTERRUPTED',
        category: 'interrupted',
        message: 'the run was interrupted before the job finished',
        phase: 'run',
      }
    );
  }
  return undefined;
}

function countsOf(results: readonly IpcResult[], expected: number): JobCounts {
  const count = (status: IpcResult['status']): number => results.filter((result) => result.status === status).length;
  return {
    tests: Math.max(expected, results.length),
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    flaky: count('flaky'),
    timedOut: count('timed-out'),
    interrupted: count('interrupted'),
  };
}

function view(record: JobRecord): JobStatusView {
  return {
    jobId: record.jobId,
    runId: record.runId,
    targetId: record.targetId,
    status: record.status,
    testFiles: record.testFiles,
    counts: record.counts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.idempotencyKey === undefined ? {} : { idempotencyKey: record.idempotencyKey }),
    ...(record.acceptedAt === undefined ? {} : { acceptedAt: record.acceptedAt }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

/** Restores one record from disk, validating every field a tool may return. */
function parseRecord(raw: unknown): JobRecord | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value['version'] !== 1) return undefined;
  const jobId = jobIdText(value['jobId']);
  const runId = jobIdText(value['runId']);
  const targetId = typeof value['targetId'] === 'string' && value['targetId'] !== '' ? value['targetId'] : undefined;
  const principal = typeof value['principal'] === 'string' && value['principal'] !== '' ? value['principal'] : 'default';
  const digest = typeof value['digest'] === 'string' ? value['digest'] : undefined;
  const status = value['status'];
  if (jobId === undefined || runId === undefined || targetId === undefined || digest === undefined || typeof status !== 'string' || !isStatus(status)) {
    return undefined;
  }
  const files = value['testFiles'];
  if (!Array.isArray(files)) return undefined;
  const testFiles = files.flatMap((file) => {
    const parsed = filePath(file);
    return parsed === undefined ? [] : [parsed];
  });
  if (testFiles.length !== files.length) return undefined;
  const ids = value['resultIds'];
  const resultIds = Array.isArray(ids) ? ids.flatMap((id) => (typeof id === 'string' ? [id] : [])) : [];
  const stored = value['results'];
  if (!Array.isArray(stored)) return undefined;
  const results = stored.flatMap((entry) => {
    const result = parseIpcResult(entry);
    return result === undefined ? [] : [result];
  });
  if (results.length !== stored.length) return undefined;
  const parsedError = value['error'] === undefined ? undefined : parseIpcError(value['error']);
  if (value['error'] !== undefined && parsedError === undefined) return undefined;
  const idempotencyKey = typeof value['idempotencyKey'] === 'string' ? value['idempotencyKey'] : undefined;
  const acceptedAt = typeof value['acceptedAt'] === 'string' ? value['acceptedAt'] : undefined;
  const startedAt = typeof value['startedAt'] === 'string' ? value['startedAt'] : undefined;
  const finishedAt = typeof value['finishedAt'] === 'string' ? value['finishedAt'] : undefined;
  return {
    version: 1,
    jobId,
    runId,
    principal,
    targetId,
    status,
    testFiles,
    digest,
    resultIds,
    results,
    counts: countsOf(results, resultIds.length),
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : timestamp(),
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : timestamp(),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(parsedError === undefined ? {} : { error: parsedError }),
  };
}

function isStatus(value: string): value is JobStatus {
  return (
    value === 'queued' ||
    value === 'collecting' ||
    value === 'waiting_auth' ||
    value === 'running' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'timed_out' ||
    value === 'interrupted' ||
    value === 'infrastructure_error' ||
    value === 'rejected'
  );
}

function digestOf(targetId: string, testFiles: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ targetId, testFiles }), 'utf8').digest('hex');
}

function bounded(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw invalid(`${name} must be a non-empty string of at most ${max} characters`);
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) < 0x20) throw invalid(`${name} must not contain control characters`);
  }
  return value;
}

function invalid(message: string): ConfigurationError {
  return new ConfigurationError('INVALID_ARGUMENT', message);
}
