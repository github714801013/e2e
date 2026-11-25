/**
 * Several jobs joining one live run through the built HTTP gateway: the second
 * submission shares the run's runId, authentication setup runs once, workers
 * grow only as far as the server cap, repeated files get their own result
 * identity, and the run and queue limits refuse with a code the client can
 * act on.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { connectHttp, invoke, startGateway } from '../helpers/http-gateway.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const TOKEN = 'concurrency-token-0123456789abcdef';
const JOB_TOOLS = ['run_test', 'get_test_status', 'get_test_report'];
const TERMINAL = new Set(['passed', 'failed', 'timed_out', 'interrupted', 'infrastructure_error', 'rejected']);

interface JobStatus {
  readonly jobId: string;
  readonly runId: string;
  readonly status: string;
  readonly testFiles: readonly string[];
  readonly counts: Record<string, number>;
  readonly acceptedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: { code: string; message: string };
}

interface JobReport extends JobStatus {
  readonly results: { readonly title: string; readonly status: string }[];
}

async function runTest(client: Client, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  return invoke(client, 'run_test', args);
}

async function submitJob(client: Client, targetId: string, file: string, idempotencyKey?: string): Promise<JobStatus> {
  const result = await runTest(client, {
    targetId,
    testFiles: [file],
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
  if (result.isError) throw new Error(`run_test failed: ${result.text}`);
  return JSON.parse(result.text) as JobStatus;
}

async function status(client: Client, jobId: string): Promise<JobStatus> {
  const result = await invoke(client, 'get_test_status', { jobId });
  if (result.isError) throw new Error(`get_test_status failed: ${result.text}`);
  return JSON.parse(result.text) as JobStatus;
}

async function report(client: Client, jobId: string): Promise<JobReport> {
  const result = await invoke(client, 'get_test_report', { jobId });
  if (result.isError) throw new Error(`get_test_report failed: ${result.text}`);
  return JSON.parse(result.text) as JobReport;
}

async function waitFor(client: Client, jobId: string): Promise<JobStatus> {
  await expect.poll(async () => TERMINAL.has((await status(client, jobId)).status), { timeout: 120_000, interval: 250 }).toBe(true);
  return status(client, jobId);
}

async function waitForStart(client: Client, jobId: string): Promise<void> {
  await expect.poll(async () => (await status(client, jobId)).startedAt !== undefined, { timeout: 60_000, interval: 200 }).toBe(true);
}

const projectFiles = (url: string): Record<string, string> => ({
  'e2e.config.ts': `import { web } from '@e2e-dev/web';

export default {
  targets: [
    { name: 'alpha', engine: web(), app: { url: ${JSON.stringify(url)} } },
    { name: 'beta', engine: web(), app: { url: ${JSON.stringify(url)} } },
    { name: 'gamma', engine: web(), app: { url: ${JSON.stringify(url)} } },
  ],
  workers: 3,
  retries: 0,
  timeout: 30000,
};
`,
  'tests/auth.e2e.ts': `import { appendFileSync } from 'node:fs';
import { test } from 'e2e';
test.setup('sign in', { sessions: ['tester'] }, async ({ app, session }) => {
  appendFileSync('setup-count.txt', 'setup\\n');
  await app.open('/storage');
  await session.save('tester');
});
`,
  'tests/quick.e2e.ts': `import { expect, test } from 'e2e';
test('quick passes', { session: 'tester' }, async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('empty');
});
`,
  'tests/hold.e2e.ts': `import { test } from 'e2e';
test('holds a worker', { session: 'tester' }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
});
`,
  'tests/hold-long.e2e.ts': `import { test } from 'e2e';
test('holds the queue', { session: 'tester' }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
});
`,
  'tests/fails.e2e.ts': `import { expect, test } from 'e2e';
test('fails on purpose', { session: 'tester' }, async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
});
`,
  'tests/p1.e2e.ts': 'import { test } from \'e2e\';\ntest(\'p1 holds\', async () => { await new Promise((resolve) => setTimeout(resolve, 3_000)); });\n',
  'tests/p2.e2e.ts': 'import { test } from \'e2e\';\ntest(\'p2 holds\', async () => { await new Promise((resolve) => setTimeout(resolve, 10_000)); });\n',
  'tests/p3.e2e.ts': 'import { test } from \'e2e\';\ntest(\'p3 holds\', async () => { await new Promise((resolve) => setTimeout(resolve, 3_000)); });\n',
  'tests/p4.e2e.ts': 'import { test } from \'e2e\';\ntest(\'p4 holds\', async () => { await new Promise((resolve) => setTimeout(resolve, 3_000)); });\n',
  'tests/bad-collect.e2e.ts': "throw new Error('collection exploded');\n",
  'tests/many.e2e.ts':
    "import { test } from 'e2e';\n" +
    Array.from({ length: 1001 }, (_, index) => `test('case ${index}', async () => {});`).join('\n') +
    '\n',
});

describe('e2e mcp --http concurrent jobs', { timeout: 300_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let crashProject: FixtureProject;
  let slowAuthProject: FixtureProject;
  let hookProject: FixtureProject;
  let disconnectProject: FixtureProject;
  let outputProject: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject(projectFiles(app.url));
    const config = projectFiles(app.url)['e2e.config.ts']!;
    // A collection that calls `process.exit` cannot be caught as unselected,
    // so the crash probe lives in its own project.
    crashProject = createProject({
      'e2e.config.ts': config,
      'tests/crash-collect.e2e.ts': 'process.exit(3);\n',
    });
    // One session has one producer project-wide; a slow sign-in needs its own
    // project so it does not collide with the shared `tester` setup.
    slowAuthProject = createProject({
      'e2e.config.ts': config,
      'tests/slow-auth.e2e.ts': `import { test } from 'e2e';
test.setup('slow sign in', { sessions: ['tester'] }, async ({ app, session }) => {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  await app.open('/storage');
  await session.save('tester');
});
test('after slow auth', { session: 'tester' }, async () => {});
`,
    });
    // A teardown hook fails after its test passed, so the job's own result is
    // already reported when the run-level error arrives.
    hookProject = createProject({
      'e2e.config.ts': config,
      'tests/hook-fail.e2e.ts': `import { afterAll, test } from 'e2e';
test('passes before the teardown', async () => {});
afterAll(() => {
  throw new Error('teardown exploded');
});
`,
    });
    // The Runner loses its IPC channel while its process stays alive, so the
    // gateway must not wait for an exit event to settle the job.
    disconnectProject = createProject({
      'e2e.config.ts': config,
      'tests/disconnect.e2e.ts': `process.disconnect();
setInterval(() => undefined, 1_000);
`,
    });
    // A project whose only run is this test's, so no earlier run's output
    // directory can be mistaken for a leak.
    outputProject = createProject({
      'e2e.config.ts': config,
      'tests/quick-output.e2e.ts': "import { test } from 'e2e';\ntest('quick', async () => {});\n",
    });
  });

  afterAll(async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        project.cleanup();
        crashProject.cleanup();
        slowAuthProject.cleanup();
        hookProject.cleanup();
        disconnectProject.cleanup();
        outputProject.cleanup();
        break;
      } catch (cause) {
        if (Date.now() > deadline) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await app?.close();
  });

  function clearSetupCount(): void {
    rmSync(path.join(project.dir, 'setup-count.txt'), { force: true });
  }

  function setupRuns(): number {
    try {
      const text = readFileSync(path.join(project.dir, 'setup-count.txt'), 'utf8').trim();
      return text === '' ? 0 : text.split('\n').length;
    } catch {
      return 0;
    }
  }

  it('adds a second job to the live run, authenticates once, and finishes it before the first', async () => {
    clearSetupCount();
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const held = await submitJob(client.client, 'alpha', 'tests/hold.e2e.ts');
      await waitForStart(client.client, held.jobId);
      const quick = await submitJob(client.client, 'alpha', 'tests/quick.e2e.ts');

      expect(quick.runId).toBe(held.runId);
      expect(quick.jobId).not.toBe(held.jobId);

      const quickDone = await waitFor(client.client, quick.jobId);
      expect(quickDone.status, JSON.stringify(quickDone.error)).toBe('passed');
      // The second job completed while the first was still holding its worker.
      expect((await status(client.client, held.jobId)).finishedAt).toBeUndefined();

      const heldDone = await waitFor(client.client, held.jobId);
      expect(heldDone.status, JSON.stringify(heldDone.error)).toBe('passed');
      expect(heldDone.runId).toBe(quickDone.runId);
      expect(quickDone.finishedAt! < heldDone.finishedAt!).toBe(true);
      expect(setupRuns()).toBe(1);

      expect((await report(client.client, quick.jobId)).results.map((entry) => entry.title)).toEqual(['quick passes']);
      expect((await report(client.client, held.jobId)).results.map((entry) => entry.title)).toEqual(['holds a worker']);
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('gives a repeated file its own result identity, and a failing job leaves its neighbour passing', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const [first, second] = await Promise.all([
        submitJob(client.client, 'alpha', 'tests/quick.e2e.ts'),
        submitJob(client.client, 'alpha', 'tests/quick.e2e.ts'),
      ]);
      expect(first.runId).toBe(second.runId);
      expect(first.jobId).not.toBe(second.jobId);

      const [firstDone, secondDone] = await Promise.all([waitFor(client.client, first.jobId), waitFor(client.client, second.jobId)]);
      expect(firstDone.status).toBe('passed');
      expect(secondDone.status).toBe('passed');
      expect((await report(client.client, first.jobId)).results).toHaveLength(1);
      expect((await report(client.client, second.jobId)).results).toHaveLength(1);

      const failed = await submitJob(client.client, 'alpha', 'tests/fails.e2e.ts');
      const passing = await submitJob(client.client, 'alpha', 'tests/quick.e2e.ts');
      expect((await waitFor(client.client, failed.jobId)).status).toBe('failed');
      expect((await waitFor(client.client, passing.jobId)).status).toBe('passed');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('collapses concurrent retries of one idempotency key into one job', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const jobs = await Promise.all([
        submitJob(client.client, 'alpha', 'tests/quick.e2e.ts', 'retry-once'),
        submitJob(client.client, 'alpha', 'tests/quick.e2e.ts', 'retry-once'),
        submitJob(client.client, 'alpha', 'tests/quick.e2e.ts', 'retry-once'),
      ]);
      expect(new Set(jobs.map((job) => job.jobId)).size).toBe(1);
      expect((await waitFor(client.client, jobs[0]!.jobId)).status).toBe('passed');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('keeps different RunKeys apart and refuses a third run until one ends', async () => {
    clearSetupCount();
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const alpha = await submitJob(client.client, 'alpha', 'tests/hold.e2e.ts');
      const beta = await submitJob(client.client, 'beta', 'tests/hold.e2e.ts');
      expect(alpha.runId).not.toBe(beta.runId);
      await waitForStart(client.client, alpha.jobId);
      await waitForStart(client.client, beta.jobId);

      // Both runs are in flight, so a third RunKey waits rather than opening
      // a second login elsewhere.
      const refused = await runTest(client.client, { targetId: 'gamma', testFiles: ['tests/quick.e2e.ts'] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('CAPACITY_EXCEEDED');
      expect((await waitFor(client.client, alpha.jobId)).status).toBe('passed');
      expect((await waitFor(client.client, beta.jobId)).status).toBe('passed');
      expect(setupRuns()).toBe(2);

      // Once the two runs idle out, the third target starts normally.
      await expect
        .poll(
          async () => {
            const retry = await runTest(client.client, { targetId: 'gamma', testFiles: ['tests/quick.e2e.ts'] });
            return retry.isError ? retry.text : 'accepted';
          },
          { timeout: 30_000, interval: 500 },
        )
        .toBe('accepted');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('refuses a run that already holds twenty unfinished jobs', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const held = await submitJob(client.client, 'alpha', 'tests/hold-long.e2e.ts');
      await waitForStart(client.client, held.jobId);
      // Every job holds too: a quick one could finish and free a queue slot
      // while the next submissions are still being collected.
      for (let index = 0; index < 19; index += 1) {
        await submitJob(client.client, 'alpha', 'tests/hold-long.e2e.ts');
      }
      const refused = await runTest(client.client, { targetId: 'alpha', testFiles: ['tests/hold-long.e2e.ts'] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('CAPACITY_EXCEEDED');
      expect(refused.text).toContain('20 unfinished jobs');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('runs at most --max-workers jobs at once even when the project asks for more', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }], ['--max-workers', '2']);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const jobs: JobStatus[] = [];
      for (const file of ['tests/p1.e2e.ts', 'tests/p2.e2e.ts', 'tests/p3.e2e.ts', 'tests/p4.e2e.ts']) {
        jobs.push(await submitJob(client.client, 'alpha', file));
      }
      const current = async (): Promise<JobStatus[]> => Promise.all(jobs.map((job) => status(client.client, job.jobId)));

      // Only two of the four can start; the project asked for three workers.
      await expect
        .poll(async () => (await current()).filter((job) => job.startedAt !== undefined).length, { timeout: 60_000, interval: 200 })
        .toBe(2);
      expect((await current()).filter((job) => job.startedAt === undefined)).toHaveLength(2);

      // p1 frees one slot; p3 takes it while p2 still holds the other, so p4
      // is still waiting even though three jobs have started by now.
      await expect.poll(async () => (await current())[0]!.finishedAt !== undefined, { timeout: 60_000, interval: 200 }).toBe(true);
      await expect.poll(async () => (await current())[2]!.startedAt !== undefined, { timeout: 60_000, interval: 200 }).toBe(true);
      expect((await current())[3]!.startedAt).toBeUndefined();

      for (const job of jobs) expect((await waitFor(client.client, job.jobId)).status).toBe('passed');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('ends every job timed out when the run deadline passes', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }], [], {
      E2E_HTTP_MCP_RUN_TIMEOUT_MS: '1500',
    });
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const held = await submitJob(client.client, 'alpha', 'tests/hold.e2e.ts');
      const done = await waitFor(client.client, held.jobId);
      expect(done.status).toBe('timed_out');
      expect(done.error?.code).toBe('RUN_TIMEOUT');
      expect(done.finishedAt).toBeDefined();
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('does not charge a queued job with another job\'s collection failure', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const bad = await submitJob(client.client, 'alpha', 'tests/bad-collect.e2e.ts');
      const queued = await submitJob(client.client, 'alpha', 'tests/quick.e2e.ts');
      const badDone = await waitFor(client.client, bad.jobId);
      const queuedDone = await waitFor(client.client, queued.jobId);
      expect(badDone.status).toBe('rejected');
      expect(badDone.error?.code).toBe('COLLECTION_ERROR');
      expect(queuedDone.status).toBe('rejected');
      expect(queuedDone.error?.message ?? '').not.toContain('collection exploded');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('refuses a submission that selects more than one thousand tests before scheduling it', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const many = await submitJob(client.client, 'alpha', 'tests/many.e2e.ts');
      const done = await waitFor(client.client, many.jobId);
      expect(done.status, JSON.stringify(done)).toBe('rejected');
      expect(done.error?.code, JSON.stringify(done.error)).toBe('INVALID_ARGUMENT');
      expect(done.error?.message).toContain('at most 1000');

      const quick = await submitJob(client.client, 'alpha', 'tests/quick.e2e.ts');
      expect((await waitFor(client.client, quick.jobId)).status).toBe('passed');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('refuses one of two runs forked at the same moment under --max-runs 1', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }], ['--max-runs', '1']);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const [alpha, beta] = await Promise.all([
        runTest(client.client, { targetId: 'alpha', testFiles: ['tests/hold.e2e.ts'] }),
        runTest(client.client, { targetId: 'beta', testFiles: ['tests/hold.e2e.ts'] }),
      ]);
      expect([alpha, beta].filter((result) => !result.isError)).toHaveLength(1);
      const refused = [alpha, beta].filter((result) => result.isError);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.text).toContain('CAPACITY_EXCEEDED');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('marks a runner that exits during collection as a failure', async () => {
    const gateway = await startGateway(crashProject, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const crashed = await submitJob(client.client, 'alpha', 'tests/crash-collect.e2e.ts');
      const finished = await waitFor(client.client, crashed.jobId);
      expect(finished.status, JSON.stringify(finished)).toBe('infrastructure_error');
      expect(finished.error?.code).toBe('WORKER_EXIT');
      expect((await report(client.client, crashed.jobId)).results).toHaveLength(0);
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('removes a stopped run\'s output directory', async () => {
    const gateway = await startGateway(outputProject, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const job = await submitJob(client.client, 'alpha', 'tests/quick-output.e2e.ts');
      expect((await waitFor(client.client, job.jobId)).status).toBe('passed');

      // The run idles out, exits, and its output directory goes with it; its
      // report was already projected over IPC.
      const runsDir = path.join(outputProject.dir, '.e2e', 'http-jobs', 'runs');
      const deadline = Date.now() + 30_000;
      for (;;) {
        let left: string[];
        try {
          left = readdirSync(runsDir);
        } catch {
          left = [];
        }
        if (left.length === 0) break;
        if (Date.now() > deadline) {
          throw new Error(`run output was not removed: ${left.join(', ')}\n${gateway.stderr()}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('fails a job whose run reports a teardown hook failure after its test passed', async () => {
    const gateway = await startGateway(hookProject, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const job = await submitJob(client.client, 'alpha', 'tests/hook-fail.e2e.ts');
      // The test result arrives before the teardown hook does, so the job can
      // read `passed` for a moment; the run-level error must still correct it.
      await expect
        .poll(async () => (await status(client.client, job.jobId)).status, { timeout: 30_000, interval: 250 })
        .toBe('failed');
      expect((await status(client.client, job.jobId)).error?.code).toBe('HOOK_FAILED');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('settles a job when the runner closes its IPC channel without exiting', async () => {
    const gateway = await startGateway(disconnectProject, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const job = await submitJob(client.client, 'alpha', 'tests/disconnect.e2e.ts');
      const finished = await waitFor(client.client, job.jobId);
      expect(finished.status, JSON.stringify(finished)).toBe('infrastructure_error');
      expect(finished.error?.code).toBe('WORKER_EXIT');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('refuses a submission when the runner misses its startup deadline', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }], [], {
      E2E_HTTP_MCP_STARTUP_TIMEOUT_MS: '500',
      E2E_HTTP_MCP_READY_DELAY_MS: '2000',
    });
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const refused = await runTest(client.client, { targetId: 'alpha', testFiles: ['tests/quick.e2e.ts'] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('WORKER_INIT_FAILED');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('ends a job that outlives the injected job deadline', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }], [], {
      E2E_HTTP_MCP_JOB_TIMEOUT_MS: '1000',
    });
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const job = await submitJob(client.client, 'alpha', 'tests/p1.e2e.ts');
      const finished = await waitFor(client.client, job.jobId);
      expect(finished.status).toBe('timed_out');
      expect(finished.error?.code).toBe('JOB_TIMEOUT');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('ends a job whose authentication outlives the injected auth deadline', async () => {
    const gateway = await startGateway(slowAuthProject, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }], [], {
      E2E_HTTP_MCP_AUTH_TIMEOUT_MS: '800',
    });
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const job = await submitJob(client.client, 'alpha', 'tests/slow-auth.e2e.ts');
      const finished = await waitFor(client.client, job.jobId);
      expect(finished.status, JSON.stringify(finished)).toBe('timed_out');
      expect(finished.error?.code).toBe('AUTH_TIMEOUT');
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('waits for a sealed run to exit before starting the successor', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }], [], {
      E2E_HTTP_MCP_RUN_TIMEOUT_MS: '1000',
    });
    const client = await connectHttp(gateway.url, TOKEN);
    try {
      const first = await submitJob(client.client, 'alpha', 'tests/hold.e2e.ts');
      expect((await waitFor(client.client, first.jobId)).status).toBe('timed_out');

      // The first run sealed on its deadline; the successor must not open a
      // second login beside it. Its directory goes when its child exits, and
      // the new run is the only one left.
      const runsDir = path.join(project.dir, '.e2e', 'http-jobs', 'runs');
      const before = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
      const next = await submitJob(client.client, 'alpha', 'tests/quick.e2e.ts');
      expect(next.runId).not.toBe(first.runId);
      await expect
        .poll(() => [...before].filter((name) => existsSync(path.join(runsDir, name))).length, { timeout: 30_000, interval: 100 })
        .toBe(0);
      await expect
        .poll(() => {
          try {
            return readdirSync(runsDir).length;
          } catch {
            return 0;
          }
        }, { timeout: 30_000, interval: 100 })
        .toBe(1);
    } finally {
      await client.transport.terminateSession().catch(() => undefined);
      await client.client.close().catch(() => undefined);
      await gateway.close();
    }
  });
});
