import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject } from '../helpers/run-project.ts';

const runnerModule = new URL(process.env['E2E_TEST_SOURCE'] === '1' ? '../../src/runner.ts' : '../../dist/runner.js', import.meta.url).href;
const runner = (await import(runnerModule)) as typeof import('../../src/runner.ts');

describe('动态公开 Runner', () => {
  let app: FixtureApp;
  beforeAll(async () => { app = await startFixtureApp(); });
  afterAll(async () => { await app.close(); });

  it('拒绝不是正整数的 maxWorkers', () => {
    for (const maxWorkers of [0, -1, 1.5, Number.NaN]) {
      expect(() => runner.runDynamic({ target: 'web', maxWorkers })).toThrow(/maxWorkers/);
    }
  });

  it('在 A 等待期间收集新建的 B，复用一次认证并通过不同 Worker 完成同一报告', async () => {
    const fixture = createProject({
      'e2e.config.ts': `import { web } from '@e2e-dev/web';
export default {
  targets: [{ name: 'web', engine: web(), app: { url: ${JSON.stringify(app.url)} } }],
  workers: 2, retries: 0, timeout: 30000,
};`,
      'tests/auth.e2e.ts': `import { appendFileSync } from 'node:fs';
import { test, expect } from 'e2e';
test.setup('保存认证', { sessions: ['tester'] }, async ({ app, screen, session }) => {
  appendFileSync(new URL('../auth-count', import.meta.url), 'login\\n');
  await app.open('/storage');
  await screen.getByRole('button', { name: 'Save marker' }).tap();
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
  await session.save('tester');
});`,
      'tests/a.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { test, expect } from 'e2e';
test('A', { session: 'tester' }, async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
  writeFileSync(new URL('../a-ready', import.meta.url), String(process.pid));
  while (!existsSync(new URL('../release-a', import.meta.url))) await setTimeout(20);
});`,
    });
    const events: RunEvent[] = [];
    const controller = new AbortController();
    let active: ReturnType<typeof runner.runDynamic> | undefined;
    try {
      active = runner.runDynamic({ cwd: fixture.dir, target: 'web', interruptSignal: controller.signal, onEvent: (event) => { events.push(event); } });
      const a = await active.submit({ jobId: 'a', files: ['tests/a.e2e.ts'] });
      await expect.poll(() => existsSync(path.join(fixture.dir, 'a-ready')), { timeout: 20000 }).toBe(true);
      expect(events.filter((event) => event.type === 'test-finished' && event.result.test.title === 'A')).toHaveLength(0);
      writeFileSync(path.join(fixture.dir, 'tests/b.e2e.ts'), `import { writeFileSync } from 'node:fs';
import { test, expect } from 'e2e';
test('B', { session: 'tester' }, async ({ app, screen }) => {
  await app.open('/storage');
  await expect(screen.getByRole('status', { name: 'Marker' })).toHaveText('saved');
  writeFileSync(new URL('../b-ready', import.meta.url), String(process.pid));
});`, 'utf8');
      const b = await active.submit({ jobId: 'b', files: ['tests/b.e2e.ts'] });
      await expect.poll(() => events.some((event) => event.type === 'test-finished' && event.result.test.title === 'B'), { timeout: 20000 }).toBe(true);
      expect(readFileSync(path.join(fixture.dir, 'a-ready'), 'utf8')).not.toBe(String(process.pid));
      expect(readFileSync(path.join(fixture.dir, 'a-ready'), 'utf8')).not.toBe(readFileSync(path.join(fixture.dir, 'b-ready'), 'utf8'));
      expect(a.resultIds).toHaveLength(1);
      expect(b.resultIds).toHaveLength(1);
      expect(a.resultIds[0]).not.toBe(b.resultIds[0]);
      writeFileSync(path.join(fixture.dir, 'release-a'), 'ok', 'utf8');
      await active.seal();
      const result = await active.result;
      expect(result.exitCode, JSON.stringify(result.report.run.errors)).toBe(0);
      expect(result.report.run.id).toBe(active.runId);
      expect(result.report.run.results.map((entry) => entry.titlePath.at(-1)).toSorted()).toEqual(['A', 'B', '保存认证'].toSorted());
      expect(result.report.run.summary).toMatchObject({ executed: 3, passed: 3 });
      expect(readFileSync(path.join(fixture.dir, 'auth-count'), 'utf8')).toBe('login\n');
      expect(events.filter((event) => event.type === 'run-started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'run-finished')).toHaveLength(1);
      expect(JSON.parse(readFileSync(result.reportPath!, 'utf8'))).toEqual(result.report);
      assertValidReport(result.report);
      const sessions = path.join(fixture.dir, '.e2e/sessions');
      if (existsSync(sessions)) expect(readdirSync(sessions)).toEqual([]);
    } finally {
      controller.abort();
      if (active !== undefined) await active.result;
      fixture.cleanup();
    }
  }, 90000);

  it('只报告提交的测试，空队列保持开放，重复文件独立执行且封口拒绝新提交', async () => {
    const fixture = createProject({
      'e2e.config.ts': `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
export default { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }], workers: 2, retries: 0 };`,
      'tests/a.e2e.ts': `import { test } from 'e2e'; test('A', async () => {});`,
      'tests/b.e2e.ts': `import { test } from 'e2e'; test('B', async () => {});`,
    });
    const events: RunEvent[] = [];
    const controller = new AbortController();
    const active = runner.runDynamic({ cwd: fixture.dir, target: 'fake', interruptSignal: controller.signal, onEvent: (event) => { events.push(event); } });
    try {
      await active.submit({ jobId: 'first', files: ['tests/a.e2e.ts'] });
      await expect.poll(() => events.filter((event) => event.type === 'test-finished').length, { timeout: 10000 }).toBe(1);
      expect(events.some((event) => event.type === 'run-finished')).toBe(false);
      const b = await active.submit({ jobId: 'second', files: ['tests/b.e2e.ts'] });
      const repeated = await active.submit({ jobId: 'third', files: ['tests/b.e2e.ts'] });
      expect(repeated.resultIds).not.toEqual(b.resultIds);
      await active.seal();
      await expect(active.submit({ jobId: 'late', files: ['tests/b.e2e.ts'] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      const result = await active.result;
      expect(result.exitCode, JSON.stringify(result.report.run.errors)).toBe(0);
      expect(result.report.run.results.map((entry) => [entry.titlePath.at(-1), entry.repeat])).toEqual([['A', 0], ['B', 0], ['B', 1]]);
      assertValidReport(result.report);
    } finally {
      controller.abort();
      await active.result;
      fixture.cleanup();
    }
  });

  it('后续提交不能引入本 Run 尚未建立的认证', async () => {
    const fixture = createProject({
      'e2e.config.ts': `import { web } from '@e2e-dev/web';
export default {
  targets: [{ name: 'web', engine: web(), app: { url: ${JSON.stringify(app.url)} } }],
  workers: 1, retries: 0, timeout: 30000,
};`,
      'tests/auth.e2e.ts': `import { test } from 'e2e';
test.setup('保存第一份认证', { sessions: ['one'] }, async ({ app, session }) => {
  await app.open('/storage');
  await session.save('one');
});
test.setup('保存第二份认证', { sessions: ['two'] }, async ({ app, session }) => {
  await app.open('/storage');
  await session.save('two');
});`,
      'tests/a.e2e.ts': `import { test } from 'e2e';
test('A', { session: 'one' }, async () => {});`,
      'tests/b.e2e.ts': `import { test } from 'e2e';
test('B', { session: 'two' }, async () => {});`,
    });
    const controller = new AbortController();
    const active = runner.runDynamic({ cwd: fixture.dir, target: 'web', interruptSignal: controller.signal });
    try {
      const a = await active.submit({ jobId: 'a', files: ['tests/a.e2e.ts'] });
      expect(a.resultIds).toHaveLength(1);
      await expect(active.submit({ jobId: 'b', files: ['tests/b.e2e.ts'] })).rejects.toMatchObject({ code: 'COLLECTION_ERROR' });
      await active.seal();
      const result = await active.result;
      expect(result.exitCode, JSON.stringify(result.report.run.errors)).toBe(0);
      expect(result.report.run.results.map((entry) => entry.titlePath.at(-1)).toSorted()).toEqual(['A', '保存第一份认证'].toSorted());
      assertValidReport(result.report);
    } finally {
      controller.abort();
      await active.result;
      fixture.cleanup();
    }
  }, 90000);

  it('提交文件中的显式跳过测试也进入报告', async () => {
    const fixture = createProject({
      'e2e.config.ts': `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
export default { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }], workers: 1, retries: 0 };`,
      'tests/mixed.e2e.ts': `import { test } from 'e2e';
test('runs', async () => {});
test.skip('skipped one', async () => {});`,
    });
    const controller = new AbortController();
    const active = runner.runDynamic({ cwd: fixture.dir, target: 'fake', interruptSignal: controller.signal });
    try {
      const submitted = await active.submit({ jobId: 'mixed', files: ['tests/*.e2e.ts'] });
      expect(submitted.resultIds).toHaveLength(2);
      await active.seal();
      const result = await active.result;
      expect(result.exitCode, JSON.stringify(result.report.run.errors)).toBe(0);
      const byTitle = new Map(result.report.run.results.map((entry) => [entry.titlePath.at(-1), entry]));
      expect(byTitle.get('runs')?.status).toBe('passed');
      expect(byTitle.get('skipped one')).toMatchObject({ status: 'skipped', selected: true });
      assertValidReport(result.report);
    } finally {
      controller.abort();
      await active.result;
      fixture.cleanup();
    }
  });

  it('尚未提交作业时取消，不产生运行级错误', async () => {
    const fixture = createProject({
      'e2e.config.ts': `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
export default { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }], workers: 1, retries: 0 };`,
      'tests/a.e2e.ts': `import { test } from 'e2e'; test('A', async () => {});`,
    });
    const events: RunEvent[] = [];
    const controller = new AbortController();
    const active = runner.runDynamic({ cwd: fixture.dir, target: 'fake', interruptSignal: controller.signal, onEvent: (event) => { events.push(event); } });
    try {
      await expect.poll(() => events.some((event) => event.type === 'run-started'), { timeout: 10000 }).toBe(true);
      controller.abort();
      const result = await active.result;
      expect(result.exitCode).toBe(130);
      expect(result.report.run.errors).toEqual([]);
      assertValidReport(result.report);
    } finally {
      controller.abort();
      await active.result;
      fixture.cleanup();
    }
  });
});
