/**
 * `run_test`, `get_test_status`, and `get_test_report` through the built HTTP
 * gateway: a real MCP client submits files, a forked Runner child collects
 * and runs them on the fixture app, and the job outlives the request that
 * queued it, including the client connection.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { connectHttp, invoke, startGateway } from '../helpers/http-gateway.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const TOKEN_A = 'job-token-alpha-0123456789abcdef';
const TOKEN_B = 'job-token-bravo-0123456789abcdef';

const JOB_TOOLS = ['run_test', 'get_test_status', 'get_test_report'];

const TERMINAL = new Set(['passed', 'failed', 'timed_out', 'interrupted', 'infrastructure_error', 'rejected']);

interface JobStatus {
  readonly jobId: string;
  readonly runId: string;
  readonly targetId: string;
  readonly status: string;
  readonly testFiles: readonly string[];
  readonly counts: Record<string, number>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acceptedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: { code: string; category: string; message: string; phase?: string };
}

interface JobReport extends JobStatus {
  readonly results: {
    readonly resultId: string;
    readonly title: string;
    readonly file: string;
    readonly status: string;
    readonly durationMs: number;
    readonly attempts: number;
    readonly failure?: { status: string; error: { code: string; message: string } };
  }[];
  readonly truncated: boolean;
}

async function jobStatus(client: Client, jobId: string): Promise<JobStatus> {
  const result = await invoke(client, 'get_test_status', { jobId });
  if (result.isError) throw new Error(`get_test_status failed: ${result.text}`);
  return JSON.parse(result.text) as JobStatus;
}

async function jobReport(client: Client, jobId: string): Promise<JobReport> {
  const result = await invoke(client, 'get_test_report', { jobId });
  if (result.isError) throw new Error(`get_test_report failed: ${result.text}`);
  return JSON.parse(result.text) as JobReport;
}

/** Polls until the job leaves its active states; returns the terminal status. */
async function waitForTerminal(client: Client, jobId: string): Promise<JobStatus> {
  await expect
    .poll(async () => TERMINAL.has((await jobStatus(client, jobId)).status), { timeout: 120_000, interval: 500 })
    .toBe(true);
  return jobStatus(client, jobId);
}

function runTest(client: Client, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  return invoke(client, 'run_test', args);
}

describe('e2e mcp --http job tools', { timeout: 180_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({
      'e2e.config.ts': `import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: ${JSON.stringify(app.url)} } }],
  workers: 1,
  retries: 0,
  timeout: 30000,
};
`,
      'tests/auth.e2e.ts': `import { test } from 'e2e';
test.setup('sign in', { sessions: ['tester'] }, async ({ app, session }) => {
  await app.open('/storage');
  await session.save('tester');
});
`,
      'tests/sample.e2e.ts': `import { expect, test } from 'e2e';
test('sample passes', { session: 'tester' }, async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('empty');
});
`,
      'tests/fails.e2e.ts': `import { expect, test } from 'e2e';
test('sample fails', { session: 'tester' }, async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
});
`,
      'tests/broken.e2e.ts': `import { test } from 'e2e';
throw new Error('broken at import');
test('never runs', async () => {});
`,
      'tests/bad-auth.e2e.ts': `import { test } from 'e2e';
test.setup('login is refused', { sessions: ['broken'] }, async () => {
  throw new Error('login rejected');
});
test('needs broken', { session: 'broken' }, async () => {});
`,
      'tests/quick.e2e.ts': `import { expect, test } from 'e2e';
test('quick passes', async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('empty');
});
`,
      'tests/slow.e2e.ts': `import { test } from 'e2e';
test('slow runs past the stop grace', async () => {
  await new Promise((resolve) => setTimeout(resolve, 120_000));
});
`,
    });
  });

  afterAll(async () => {
    // A browser can hold files under the project for a moment after its run
    // closes; Windows refuses the removal until it lets go.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        project.cleanup();
        break;
      } catch (cause) {
        if (Date.now() > deadline) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await app?.close();
  });

  it('runs a submitted file to a report, replays an idempotency key, and keeps the job private', async () => {
    const gateway = await startGateway(project, app, [
      { token: TOKEN_A, principal: 'alpha', tools: JOB_TOOLS },
      { token: TOKEN_B, principal: 'bravo', tools: JOB_TOOLS },
    ]);
    const alpha = await connectHttp(gateway.url, TOKEN_A);
    let bravo: Awaited<ReturnType<typeof connectHttp>> | undefined;
    try {
      // A token granted only job tools never starts the native stdio server.
      const listed = await alpha.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(JOB_TOOLS);

      const refused = await runTest(alpha.client, { targetId: 'web', testFiles: ['tests/sample.e2e.ts'], workers: 4 });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('does not take "workers"');

      const submitted = await runTest(alpha.client, {
        targetId: 'web',
        testFiles: ['tests/sample.e2e.ts'],
        idempotencyKey: 'once',
      });
      expect(submitted.isError, submitted.text).toBe(false);
      const accepted = JSON.parse(submitted.text) as JobStatus;
      expect(accepted.jobId).toBeTruthy();
      expect(accepted.runId).toBeTruthy();
      expect(accepted.targetId).toBe('web');
      expect(accepted.testFiles).toEqual(['tests/sample.e2e.ts']);

      // The same key and request return the job already queued, not a second one.
      const replayed = JSON.parse(
        (await runTest(alpha.client, { targetId: 'web', testFiles: ['tests/sample.e2e.ts'], idempotencyKey: 'once' })).text,
      ) as JobStatus;
      expect(replayed.jobId).toBe(accepted.jobId);
      await expect(
        runTest(alpha.client, { targetId: 'web', testFiles: ['tests/fails.e2e.ts'], idempotencyKey: 'once' }),
      ).resolves.toMatchObject({ isError: true });

      const finished = await waitForTerminal(alpha.client, accepted.jobId);
      expect(finished.status, JSON.stringify(finished.error)).toBe('passed');
      expect(finished.counts).toMatchObject({ tests: 1, passed: 1, failed: 0, skipped: 0 });
      expect(finished.acceptedAt).toBeTruthy();
      expect(finished.startedAt).toBeTruthy();
      expect(finished.finishedAt).toBeTruthy();

      const report = await jobReport(alpha.client, accepted.jobId);
      expect(report.truncated).toBe(false);
      expect(report.results).toHaveLength(1);
      expect(report.results[0]).toMatchObject({
        title: 'sample passes',
        file: 'tests/sample.e2e.ts',
        status: 'passed',
        attempts: 1,
      });
      expect(report.results[0]!.durationMs).toBeGreaterThanOrEqual(0);
      // The response never names a path on disk.
      expect(JSON.stringify(report)).not.toContain(project.dir);
      expect(JSON.stringify(report)).not.toContain(path.join('.e2e', 'http-jobs'));

      // The job is stored server-side, under the project, keyed by its id.
      const stored = path.join(project.dir, '.e2e', 'http-jobs', `${accepted.jobId}.json`);
      expect(existsSync(stored)).toBe(true);
      expect((JSON.parse(readFileSync(stored, 'utf8')) as JobStatus).status).toBe('passed');
      expect(existsSync(path.join(project.dir, '.e2e', 'http-jobs', 'runs'))).toBe(true);

      // Another principal may neither read the status nor the report.
      bravo = await connectHttp(gateway.url, TOKEN_B);
      const status = await invoke(bravo.client, 'get_test_status', { jobId: accepted.jobId });
      expect(status.isError).toBe(true);
      expect(status.text).toContain('POLICY_DENIED');
      const reportForbidden = await invoke(bravo.client, 'get_test_report', { jobId: accepted.jobId });
      expect(reportForbidden.isError).toBe(true);
      expect(reportForbidden.text).toContain('POLICY_DENIED');

      const unknown = await invoke(alpha.client, 'get_test_status', { jobId: 'no-such-job' });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('INVALID_ARGUMENT');

      // No native `e2e mcp` child was ever spawned for this session.
      expect(gateway.stderr()).not.toContain('child ready');
    } finally {
      await bravo?.transport.terminateSession().catch(() => undefined);
      await bravo?.client.close().catch(() => undefined);
      await alpha.transport.terminateSession().catch(() => undefined);
      await alpha.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('reports a business failure with its error and bounded evidence', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha', tools: JOB_TOOLS }]);
    const alpha = await connectHttp(gateway.url, TOKEN_A);
    try {
      const submitted = JSON.parse((await runTest(alpha.client, { targetId: 'web', testFiles: ['tests/fails.e2e.ts'] })).text) as JobStatus;
      const finished = await waitForTerminal(alpha.client, submitted.jobId);
      expect(finished.status).toBe('failed');
      expect(finished.counts).toMatchObject({ tests: 1, passed: 0, failed: 1 });

      const report = await jobReport(alpha.client, submitted.jobId);
      const [result] = report.results;
      expect(result).toMatchObject({ title: 'sample fails', status: 'failed', file: 'tests/fails.e2e.ts' });
      expect(result?.failure?.status).toBe('failed');
      expect(result?.failure?.error.message).toBeTruthy();
      expect(JSON.stringify(report)).not.toContain(project.dir);
    } finally {
      await alpha.transport.terminateSession().catch(() => undefined);
      await alpha.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('records a collection error as a rejected job, not a silent empty run', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha', tools: JOB_TOOLS }]);
    const alpha = await connectHttp(gateway.url, TOKEN_A);
    try {
      const submitted = await runTest(alpha.client, { targetId: 'web', testFiles: ['tests/broken.e2e.ts'] });
      expect(submitted.isError, submitted.text).toBe(false);
      const { jobId } = JSON.parse(submitted.text) as JobStatus;
      const finished = await waitForTerminal(alpha.client, jobId);
      expect(finished.status).toBe('rejected');
      expect(finished.error?.code).toBe('COLLECTION_ERROR');
      expect(finished.error?.phase).toBe('collection');
    } finally {
      await alpha.transport.terminateSession().catch(() => undefined);
      await alpha.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('refuses a target the project does not configure', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha', tools: JOB_TOOLS }]);
    const alpha = await connectHttp(gateway.url, TOKEN_A);
    try {
      const submitted = await runTest(alpha.client, { targetId: 'nope', testFiles: ['tests/sample.e2e.ts'] });
      // The gateway cannot validate a target without loading the config; the
      // Runner answers with UNKNOWN_TARGET, either before the job is accepted
      // or on its status.
      if (submitted.isError) {
        expect(submitted.text).toMatch(/UNKNOWN_TARGET|WORKER_EXIT|CANCELLED/);
        return;
      }
      const { jobId } = JSON.parse(submitted.text) as JobStatus;
      const finished = await waitForTerminal(alpha.client, jobId);
      expect(finished.status).toBe('infrastructure_error');
      expect(finished.error?.code).toBe('UNKNOWN_TARGET');
    } finally {
      await alpha.transport.terminateSession().catch(() => undefined);
      await alpha.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('fails the job when its authentication setup fails', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha', tools: JOB_TOOLS }]);
    const alpha = await connectHttp(gateway.url, TOKEN_A);
    try {
      const submitted = JSON.parse((await runTest(alpha.client, { targetId: 'web', testFiles: ['tests/bad-auth.e2e.ts'] })).text) as JobStatus;
      const finished = await waitForTerminal(alpha.client, submitted.jobId);
      expect(finished.status).toBe('failed');
      expect(finished.error?.phase).toBe('auth');
      expect(finished.error?.message).toContain('login rejected');
    } finally {
      await alpha.transport.terminateSession().catch(() => undefined);
      await alpha.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('marks a queued job interrupted, not passed, when the gateway stops mid-run', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha', tools: JOB_TOOLS }]);
    let alpha: Awaited<ReturnType<typeof connectHttp>> | undefined;
    try {
      alpha = await connectHttp(gateway.url, TOKEN_A);
      const slow = JSON.parse((await runTest(alpha.client, { targetId: 'web', testFiles: ['tests/slow.e2e.ts'] })).text) as JobStatus;
      // `running` alone is set when authentication settles; wait until the
      // test body itself started, so closing cuts a run that is in flight.
      await expect
        .poll(async () => (await jobStatus(alpha!.client, slow.jobId)).startedAt !== undefined, { timeout: 30_000, interval: 200 })
        .toBe(true);
      const queued = JSON.parse((await runTest(alpha.client, { targetId: 'web', testFiles: ['tests/quick.e2e.ts'] })).text) as JobStatus;

      // The run cannot drain within its stop grace: the child is aborted, and
      // the queued job never runs.
      await gateway.close();
      await alpha.transport.terminateSession().catch(() => undefined);
      await alpha.client.close().catch(() => undefined);
      alpha = undefined;

      // A restarted gateway reads the records; the queued job must not be a pass.
      const restarted = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha', tools: JOB_TOOLS }]);
      const second = await connectHttp(restarted.url, TOKEN_A);
      try {
        const finished = await jobStatus(second.client, queued.jobId);
        expect(finished.status).toBe('interrupted');
        // The queued job never collected, so its report carries no results;
        // nothing may claim a pass.
        const report = await jobReport(second.client, queued.jobId);
        expect(report.results).toEqual([]);
      } finally {
        await second.transport.terminateSession().catch(() => undefined);
        await second.client.close().catch(() => undefined);
        await restarted.close();
      }
    } finally {
      await alpha?.transport.terminateSession().catch(() => undefined);
      await alpha?.client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('keeps running after the submitting connection closes, and a new connection can read it', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha', tools: JOB_TOOLS }]);
    const first = await connectHttp(gateway.url, TOKEN_A);
    const second = await connectHttp(gateway.url, TOKEN_A);
    try {
      const submitted = JSON.parse((await runTest(first.client, { targetId: 'web', testFiles: ['tests/sample.e2e.ts'] })).text) as JobStatus;
      // Drop the connection that queued the job before it can finish.
      await first.transport.terminateSession().catch(() => undefined);
      await first.client.close().catch(() => undefined);

      const finished = await waitForTerminal(second.client, submitted.jobId);
      expect(finished.status).toBe('passed');
      expect((await jobReport(second.client, submitted.jobId)).results).toHaveLength(1);
      expect(readdirSync(path.join(project.dir, '.e2e', 'http-jobs')).length).toBeGreaterThan(0);
    } finally {
      await first.transport.terminateSession().catch(() => undefined);
      await first.client.close().catch(() => undefined);
      await second.transport.terminateSession().catch(() => undefined);
      await second.client.close().catch(() => undefined);
      await gateway.close();
    }
  });
});
