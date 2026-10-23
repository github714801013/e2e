/**
 * The gateway's job store without a Runner child: persistence across a
 * restart, ownership, report bounds, idempotent replay from disk, and the
 * closed tool arguments. The runner path itself lives in the integration test.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_TIMEOUT_MS, type HttpMcpToken } from '../../src/mcp/http/config.ts';
import { JOB_TOOL_DEFINITIONS, callJobTool } from '../../src/mcp/http/job-tools.ts';
import { JobService } from '../../src/mcp/http/jobs.ts';

const ALPHA: HttpMcpToken = { principal: 'alpha', tools: [], digest: Buffer.alloc(32) };
const BRAVO: HttpMcpToken = { principal: 'bravo', tools: [], digest: Buffer.alloc(32) };

const roots: string[] = [];
const services: JobService[] = [];

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-http-jobs-'));
  roots.push(dir);
  return dir;
}

function digestOf(targetId: string, testFiles: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ targetId, testFiles }), 'utf8').digest('hex');
}

function jobFile(dir: string, jobId: string): string {
  return path.join(dir, '.e2e', 'http-jobs', `${jobId}.json`);
}

/** Writes one stored record the way a previous gateway would have. */
function writeJob(dir: string, overrides: Record<string, unknown> = {}): string {
  const jobId = (overrides['jobId'] as string | undefined) ?? 'job-1';
  const targetId = (overrides['targetId'] as string | undefined) ?? 'web';
  const testFiles = (overrides['testFiles'] as string[] | undefined) ?? ['tests/a.e2e.ts'];
  const record = {
    version: 1,
    jobId,
    runId: 'run-1',
    principal: 'alpha',
    targetId,
    status: 'running',
    testFiles,
    digest: digestOf(targetId, testFiles),
    resultIds: [],
    results: [],
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
  mkdirSync(path.dirname(jobFile(dir, jobId)), { recursive: true });
  writeFileSync(jobFile(dir, jobId), JSON.stringify(record), 'utf8');
  return jobId;
}

async function create(dir: string): Promise<JobService> {
  const service = await JobService.create({
    cwd: dir,
    env: {},
    maxWorkers: 4,
    maxRuns: 2,
    runTimeoutMs: RUN_TIMEOUT_MS,
    log: () => undefined,
  });
  services.push(service);
  return service;
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('HTTP MCP job store', () => {
  it('marks a job a previous gateway left running as interrupted, and persists it', async () => {
    const dir = root();
    writeJob(dir, { status: 'waiting_auth' });
    const service = await create(dir);

    const status = service.status(ALPHA, 'job-1');
    expect(status.status).toBe('interrupted');
    expect(status.error).toMatchObject({ code: 'INTERRUPTED', category: 'interrupted' });
    expect(status.acceptedAt).toBeUndefined();

    const stored = JSON.parse(readFileSync(jobFile(dir, 'job-1'), 'utf8')) as { status: string };
    expect(stored.status).toBe('interrupted');
  });

  it('removes a finished job past its retention instead of restoring it', async () => {
    const dir = root();
    writeJob(dir, { status: 'passed', finishedAt: '2020-01-01T00:00:00.000Z' });
    const service = await create(dir);

    expect(() => service.status(ALPHA, 'job-1')).toThrow(/does not exist/);
    expect(existsSync(jobFile(dir, 'job-1'))).toBe(false);
  });

  it('removes a run output directory a killed gateway left behind', async () => {
    const dir = root();
    mkdirSync(path.join(dir, '.e2e', 'http-jobs', 'runs', 'stale-run', 'sessions'), { recursive: true });
    writeFileSync(path.join(dir, '.e2e', 'http-jobs', 'runs', 'stale-run', 'sessions', 'tester.json'), 'snapshot', 'utf8');
    await create(dir);

    expect(existsSync(path.join(dir, '.e2e', 'http-jobs', 'runs', 'stale-run'))).toBe(false);
  });

  it('sweeps a finished job after the injected retention', async () => {
    const dir = root();
    writeJob(dir, { status: 'passed', finishedAt: new Date().toISOString() });
    const service = await JobService.create({
      cwd: dir,
      env: {},
      maxWorkers: 4,
      maxRuns: 2,
      runTimeoutMs: RUN_TIMEOUT_MS,
      retentionMs: 50,
      log: () => undefined,
    });
    services.push(service);

    expect(service.status(ALPHA, 'job-1').status).toBe('passed');
    await expect.poll(() => existsSync(jobFile(dir, 'job-1')), { timeout: 5_000, interval: 25 }).toBe(false);
    expect(() => service.status(ALPHA, 'job-1')).toThrow(/does not exist/);
  });

  it('serves a job only to the principal that submitted it', async () => {
    const dir = root();
    writeJob(dir, { status: 'passed' });
    const service = await create(dir);

    expect(service.status(ALPHA, 'job-1').status).toBe('passed');
    expect(() => service.status(BRAVO, 'job-1')).toThrow(/POLICY_DENIED|belongs to another client/);
    expect(() => service.report(BRAVO, 'job-1')).toThrow(/another client/);
    expect(() => service.status(ALPHA, 'missing')).toThrow(/does not exist/);
    expect(() => service.status(ALPHA, '')).toThrow(/jobId/);
  });

  it('bounds a report by result count and by serialized size', async () => {
    const dir = root();
    const results = Array.from({ length: 60 }, (_, index) => ({
      resultId: `r${index}`,
      title: `test ${index}`,
      titlePath: [`test ${index}`],
      file: 'tests/a.e2e.ts',
      status: 'failed',
      durationMs: index,
      attempts: 1,
      failure: {
        status: 'failed',
        durationMs: index,
        error: { code: 'EXPECT_FAILED', category: 'test', message: 'boom' },
        evidence: ['x'.repeat(4096), 'y'.repeat(4096), 'z'.repeat(4096), 'w'.repeat(4096), 'v'.repeat(4096)],
      },
    }));
    writeJob(dir, { jobId: 'big', status: 'failed', resultIds: results.map((result) => result.resultId), results });
    const service = await create(dir);

    const report = service.report(ALPHA, 'big');
    expect(report.truncated).toBe(true);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.length).toBeLessThan(60);
    expect(Buffer.byteLength(JSON.stringify(report.results), 'utf8')).toBeLessThan(256 * 1024);
    expect(report.counts).toMatchObject({ tests: 60, failed: 60 });
  });

  it('replays an idempotency key from disk, and refuses the same key for another request', async () => {
    const dir = root();
    writeJob(dir, { jobId: 'first', status: 'passed', idempotencyKey: 'k1' });
    const service = await create(dir);

    const replay = await service.submit(ALPHA, { targetId: 'web', testFiles: ['tests/a.e2e.ts'], idempotencyKey: 'k1' });
    expect(replay.jobId).toBe('first');
    expect(replay.status).toBe('passed');
    await expect(
      service.submit(ALPHA, { targetId: 'web', testFiles: ['tests/other.e2e.ts'], idempotencyKey: 'k1' }),
    ).rejects.toThrow(/different request/);
  });

  it('refuses a submission naming a path outside the project or an unknown tool field', async () => {
    const dir = root();
    const service = await create(dir);

    await expect(service.submit(ALPHA, { targetId: 'web', testFiles: [] })).rejects.toThrow(/testFiles/);
    await expect(service.submit(ALPHA, { targetId: 'web', testFiles: ['/etc/passwd'] })).rejects.toThrow(/project-relative/);
    await expect(service.submit(ALPHA, { targetId: 'web', testFiles: ['../up.e2e.ts'] })).rejects.toThrow(/project-relative/);

    await expect(
      callJobTool(service, ALPHA, 'run_test', { targetId: 'web', testFiles: ['tests/a.e2e.ts'], workers: 4 }),
    ).rejects.toThrow(/does not take "workers"/);
    await expect(callJobTool(service, ALPHA, 'get_test_status', { jobId: 'missing', extra: true })).rejects.toThrow(/does not take/);
    await expect(callJobTool(service, ALPHA, 'get_test_status', {})).rejects.toThrow(/jobId/);
  });

  it('refuses a job directory that is a link to somewhere else', async () => {
    const dir = root();
    const outside = root();
    symlinkSync(outside, path.join(dir, '.e2e'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      JobService.create({ cwd: dir, env: {}, maxWorkers: 4, maxRuns: 2, runTimeoutMs: RUN_TIMEOUT_MS, log: () => undefined }),
    ).rejects.toThrow(
      /not a real directory/,
    );
  });

  it('declares no workers or arbitrary command argument on run_test', () => {
    const runTest = JOB_TOOL_DEFINITIONS.find((tool) => tool.name === 'run_test');
    expect(runTest?.inputSchema).toMatchObject({
      properties: { targetId: expect.any(Object), testFiles: expect.any(Object), idempotencyKey: expect.any(Object) },
      additionalProperties: false,
    });
    expect(Object.keys(runTest?.inputSchema.properties ?? {})).toEqual(['targetId', 'testFiles', 'idempotencyKey']);
    expect(JOB_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(['run_test', 'get_test_status', 'get_test_report']);
  });
});
