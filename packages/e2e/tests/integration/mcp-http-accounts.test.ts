/**
 * The HTTP gateway's account pool: the admin API's credential, validation,
 * persistence, and the guarantee that no response, log, or account file carries
 * a password. The pool directory is a throwaway temp directory per test; the
 * gateway is the built CLI, started exactly as a deployment starts it.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { connectHttp, invoke, startGateway, type Gateway } from '../helpers/http-gateway.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const ADMIN_TOKEN = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const MCP_TOKEN = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const PASSWORD = 'account-password-one';
const NEW_PASSWORD = 'account-password-two';

const CONFIG = `import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 1,
  retries: 0,
  timeout: 15000,
};
`;

/** A project shaped like the deployed one: it prefers the gateway's runtime targets. */
const RUNTIME_CONFIG = `import { readFileSync } from 'node:fs';
import { web } from '@e2e-dev/web';

const file = process.env.E2E_TARGETS_FILE;
const declared: { name: string; url: string }[] = file === undefined ? [] : JSON.parse(readFileSync(file, 'utf8'));

export default {
  targets: declared.map((target) => ({ name: target.name, engine: web(), app: { url: target.url } })),
  workers: 1,
  retries: 0,
  timeout: 15000,
};
`;

const PASS_TEST = `import { expect, test } from 'e2e';

test('passes on the resolved account', async () => {
  expect(1).toBe(1);
});
`;

const JOB_TOOLS = ['run_test', 'get_test_status', 'get_test_report', 'list_test_scripts'];

interface Store {
  readonly dir: string;
  readonly baseFile: string;
}

interface AdminResponse {
  readonly status: number;
  readonly text: string;
  readonly body: unknown;
}

describe('e2e mcp --http account pool admin API', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const stores: Store[] = [];

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': CONFIG });
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
    await Promise.all(stores.map((store) => rm(store.dir, { recursive: true, force: true })));
  });

  async function freshStore(baseUrl = 'http://127.0.0.1:1'): Promise<Store> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'e2e-accounts-'));
    const baseFile = path.join(dir, 'base-targets.json');
    await writeFile(
      baseFile,
      JSON.stringify([{ name: 'base', url: baseUrl, username: 'base-user', password: 'base-password' }]),
    );
    const store = { dir, baseFile };
    stores.push(store);
    return store;
  }

  async function start(
    store: Store,
    adminToken: string | null = ADMIN_TOKEN,
    projectToUse: FixtureProject = project,
  ): Promise<Gateway> {
    return startGateway(projectToUse, app, [{ token: MCP_TOKEN, principal: 'tester' }], [], {
      E2E_HTTP_MCP_ACCOUNTS_DIR: store.dir,
      E2E_TARGETS_BASE_FILE: store.baseFile,
      E2E_HTTP_MCP_ADMIN_TOKEN: adminToken ?? undefined,
    });
  }

  async function startJobs(store: Store, projectToRun: FixtureProject): Promise<Gateway> {
    return startGateway(projectToRun, app, [{ token: MCP_TOKEN, principal: 'tester', tools: JOB_TOOLS }], [], {
      E2E_HTTP_MCP_ACCOUNTS_DIR: store.dir,
      E2E_TARGETS_BASE_FILE: store.baseFile,
      E2E_HTTP_MCP_ADMIN_TOKEN: ADMIN_TOKEN,
    });
  }

  async function waitForJob(client: Client, jobId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = JSON.parse((await invoke(client, 'get_test_status', { jobId })).text) as Record<string, unknown>;
      const state = status['status'];
      if (['passed', 'failed', 'timed_out', 'interrupted', 'infrastructure_error', 'rejected'].includes(String(state))) {
        return status;
      }
      if (Date.now() > deadline) throw new Error(`job did not finish: ${JSON.stringify(status)}`);
      await delay(300);
    }
  }

  async function admin(
    gateway: Gateway,
    method: string,
    route: string,
    body?: unknown,
    token: string | undefined = ADMIN_TOKEN,
  ): Promise<AdminResponse> {
    const response = await fetch(`http://${new URL(gateway.url).host}${route}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
  }

  function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: 'oa-pc-main',
      description: 'OA 电脑端 主账号',
      url: 'https://oa.dev.9ji.com',
      username: 'xswl29563',
      password: PASSWORD,
      ...overrides,
    };
  }

  async function files(store: Store): Promise<{ accounts: string; secrets: string }> {
    return {
      accounts: await readFile(path.join(store.dir, 'accounts.json'), 'utf8'),
      secrets: await readFile(path.join(store.dir, 'secrets.env'), 'utf8'),
    };
  }

  it('serves no admin route when E2E_HTTP_MCP_ADMIN_TOKEN is unset', async () => {
    const store = await freshStore();
    const gateway = await start(store, null);
    try {
      expect((await admin(gateway, 'GET', '/admin/api/accounts')).status).toBe(404);
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account())).status).toBe(404);
      expect((await fetch(`http://${new URL(gateway.url).host}/admin`)).status).toBe(404);
      expect((await fetch(new URL('/healthz', gateway.url))).status).toBe(200);
      await expect(readFile(path.join(store.dir, 'accounts.json'), 'utf8')).rejects.toThrow();
    } finally {
      await gateway.close();
    }
  });

  it('serves a static admin page shell, never account data', async () => {
    const store = await freshStore();
    const gateway = await start(store);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account())).status).toBe(201);
      const origin = `http://${new URL(gateway.url).host}`;
      const page = await fetch(`${origin}/admin?token=${encodeURIComponent(ADMIN_TOKEN)}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await page.text();
      expect(html).toContain('e2e 账号池管理');
      expect(html).toContain('sessionStorage');
      expect(html).toContain('history.replaceState');
      // The shell is static: the token and every account field are fetched later.
      expect(html).not.toContain(ADMIN_TOKEN);
      expect(html).not.toContain(PASSWORD);
      expect(html).not.toContain('OA 电脑端 主账号');

      const posted = await fetch(`${origin}/admin`, { method: 'POST' });
      expect(posted.status).toBe(405);
      expect(posted.headers.get('allow')).toBe('GET');
      expect(await posted.json()).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } });
    } finally {
      await gateway.close();
    }
  });

  it('refuses a wrong token without touching the account files', async () => {
    const store = await freshStore();
    const gateway = await start(store);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account())).status).toBe(201);
      const before = await files(store);
      const refused = await admin(gateway, 'GET', '/admin/api/accounts', undefined, 'wrong-token-0123456789abcdef01234567');
      expect(refused.status).toBe(401);
      expect(refused.text).toContain('ADMIN_UNAUTHORIZED');
      expect(await files(store)).toEqual(before);
    } finally {
      await gateway.close();
    }
  });

  it('creates an account into accounts.json and a 0600 secrets file, never echoing the password', async () => {
    const store = await freshStore();
    const gateway = await start(store);
    try {
      const created = await admin(gateway, 'POST', '/admin/api/accounts', account());
      expect(created.status, created.text).toBe(201);
      expect(created.text).not.toContain(PASSWORD);
      const list = await admin(gateway, 'GET', '/admin/api/accounts');
      expect(list.status).toBe(200);
      expect(list.text).not.toContain(PASSWORD);
      const view = (list.body as { accounts: { name: string; description: string; enabled: boolean; username: string; url: string }[] }).accounts[0]!;
      expect(view).toMatchObject({
        name: 'oa-pc-main',
        description: 'OA 电脑端 主账号',
        url: 'https://oa.dev.9ji.com',
        username: 'xswl29563',
        enabled: true,
      });

      const stored = await files(store);
      expect(stored.accounts).not.toContain(PASSWORD);
      const document = JSON.parse(stored.accounts) as { version: number; accounts: Record<string, unknown>[] };
      expect(document.version).toBe(1);
      expect(document.accounts[0]).toMatchObject({
        name: 'oa-pc-main',
        description: 'OA 电脑端 主账号',
        url: 'https://oa.dev.9ji.com',
        username: 'xswl29563',
        passwordRef: 'E2E_ACCOUNT_OA_PC_MAIN_PASSWORD',
        enabled: true,
      });
      expect(document.accounts[0]).not.toHaveProperty('password');
      expect(typeof document.accounts[0]!['createdAt']).toBe('string');
      expect(typeof document.accounts[0]!['updatedAt']).toBe('string');

      const secretLine = stored.secrets.split('\n').find((line) => line.startsWith('E2E_ACCOUNT_OA_PC_MAIN_PASSWORD='))!;
      expect(JSON.parse(secretLine.slice('E2E_ACCOUNT_OA_PC_MAIN_PASSWORD='.length))).toBe(PASSWORD);
      if (process.platform !== 'win32') {
        expect((await stat(path.join(store.dir, 'secrets.env'))).mode & 0o777).toBe(0o600);
        expect((await stat(path.join(store.dir, 'accounts.json'))).mode & 0o777).toBe(0o600);
      }
      expect(gateway.stderr()).not.toContain(PASSWORD);
    } finally {
      await gateway.close();
    }
  });

  it('rejects every invalid create and leaves the files byte-for-byte unchanged', async () => {
    const store = await freshStore();
    const gateway = await start(store);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account())).status).toBe(201);
      const before = await files(store);
      const long = '字'.repeat(201);
      const cases: [string, Record<string, unknown>, number][] = [
        ['uppercase name', account({ name: 'OA-PC' }), 400],
        ['leading hyphen', account({ name: '-oa' }), 400],
        ['duplicate name', account(), 400],
        ['base target name', account({ name: 'base' }), 400],
        ['empty description', account({ description: '   ' }), 400],
        ['long description', account({ description: long }), 400],
        ['non-http url', account({ url: 'ftp://oa.dev.9ji.com' }), 400],
        ['empty username', account({ username: ' ' }), 400],
        ['empty password', account({ password: '' }), 400],
      ];
      for (const [label, input, status] of cases) {
        const answer = await admin(gateway, 'POST', '/admin/api/accounts', input);
        expect(answer.status, label).toBe(status);
        expect(answer.text, label).not.toContain(PASSWORD);
      }
      expect(await files(store)).toEqual(before);

      const malformed = await fetch(`http://${new URL(gateway.url).host}/admin/api/accounts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: '{',
      });
      expect(malformed.status).toBe(400);
      expect(await files(store)).toEqual(before);
    } finally {
      await gateway.close();
    }
  });

  it('updates the description, the enabled flag, and the password', async () => {
    const store = await freshStore();
    const gateway = await start(store);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account())).status).toBe(201);
      const renamed = await admin(gateway, 'PATCH', '/admin/api/accounts/oa-pc-main', { description: 'OA 电脑端 备用账号' });
      expect(renamed.status).toBe(200);
      expect(renamed.text).not.toContain(PASSWORD);
      const disabled = await admin(gateway, 'PATCH', '/admin/api/accounts/oa-pc-main', { enabled: false });
      expect(disabled.status).toBe(200);
      const rotated = await admin(gateway, 'PATCH', '/admin/api/accounts/oa-pc-main', { password: NEW_PASSWORD });
      expect(rotated.status).toBe(200);
      expect(rotated.text).not.toContain(NEW_PASSWORD);

      const view = (await admin(gateway, 'GET', '/admin/api/accounts')).body as {
        accounts: { description: string; enabled: boolean }[];
      };
      expect(view.accounts[0]).toMatchObject({ description: 'OA 电脑端 备用账号', enabled: false });
      const stored = await files(store);
      expect(stored.accounts).not.toContain(PASSWORD);
      const secretLine = stored.secrets.split('\n').find((line) => line.startsWith('E2E_ACCOUNT_OA_PC_MAIN_PASSWORD='))!;
      expect(JSON.parse(secretLine.slice('E2E_ACCOUNT_OA_PC_MAIN_PASSWORD='.length))).toBe(NEW_PASSWORD);
      expect(gateway.stderr()).not.toContain(NEW_PASSWORD);

      const unknown = await admin(gateway, 'PATCH', '/admin/api/accounts/oa-pc-main', { name: 'other' });
      expect(unknown.status).toBe(400);
      expect((await admin(gateway, 'PATCH', '/admin/api/accounts/missing', { enabled: true })).status).toBe(404);
    } finally {
      await gateway.close();
    }
  });

  it('deletes an account and its secret key', async () => {
    const store = await freshStore();
    const gateway = await start(store);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account())).status).toBe(201);
      expect((await admin(gateway, 'DELETE', '/admin/api/accounts/oa-pc-main')).status).toBe(204);
      const list = (await admin(gateway, 'GET', '/admin/api/accounts')).body as { accounts: unknown[] };
      expect(list.accounts).toEqual([]);
      const stored = await files(store);
      expect(stored.accounts).not.toContain('oa-pc-main');
      expect(stored.secrets).not.toContain('E2E_ACCOUNT_OA_PC_MAIN_PASSWORD');
      expect((await admin(gateway, 'DELETE', '/admin/api/accounts/oa-pc-main')).status).toBe(404);
    } finally {
      await gateway.close();
    }
  });

  it('keeps the pool across a gateway restart', async () => {
    const store = await freshStore();
    const first = await start(store);
    try {
      expect((await admin(first, 'POST', '/admin/api/accounts', account())).status).toBe(201);
    } finally {
      await first.close();
    }
    const second = await start(store);
    try {
      const list = (await admin(second, 'GET', '/admin/api/accounts')).body as { accounts: { name: string }[] };
      expect(list.accounts.map((entry) => entry.name)).toEqual(['oa-pc-main']);
    } finally {
      await second.close();
    }
  });

  it('lists account entries beside the base targets, with no credential', async () => {
    const store = await freshStore();
    const gateway = await start(store);
    const { client, transport } = await connectHttp(gateway.url, MCP_TOKEN);
    try {
      const empty = JSON.parse((await invoke(client, 'list_test_scripts')).text) as { targets: { name: string; url: string }[] };
      expect(empty.targets).toMatchObject([{ name: 'web' }]);
      expect(empty.targets[0]!.url).toBe(`${app.url}/`);

      expect((await admin(gateway, 'POST', '/admin/api/accounts', account())).status).toBe(201);
      expect(
        (await admin(gateway, 'POST', '/admin/api/accounts', account({ name: 'oa-pc-backup', description: 'OA 电脑端 备用账号' })))
          .status,
      ).toBe(201);
      expect((await admin(gateway, 'PATCH', '/admin/api/accounts/oa-pc-backup', { enabled: false })).status).toBe(200);

      const listed = await invoke(client, 'list_test_scripts');
      expect(listed.isError).toBe(false);
      expect(listed.text).not.toContain(PASSWORD);
      expect(listed.text).not.toContain('passwordRef');
      const targets = (JSON.parse(listed.text) as { targets: Record<string, unknown>[] }).targets;
      const byName = Object.fromEntries(targets.map((target) => [target['name'], target]));
      expect(byName['web']).toMatchObject({ name: 'web' });
      expect(byName['web']!['url']).toBe(`${app.url}/`);
      expect(byName['oa-pc-main']).toMatchObject({
        name: 'oa-pc-main',
        url: 'https://oa.dev.9ji.com',
        description: 'OA 电脑端 主账号',
        enabled: true,
      });
      expect(byName['oa-pc-backup']).toMatchObject({ description: 'OA 电脑端 备用账号', enabled: false });

      expect((await admin(gateway, 'DELETE', '/admin/api/accounts/oa-pc-main')).status).toBe(204);
      const after = JSON.parse((await invoke(client, 'list_test_scripts')).text) as { targets: { name: string }[] };
      expect(after.targets.map((target) => target.name)).toEqual(['web', 'oa-pc-backup']);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('collects a project whose targets come only from the runtime file', async () => {
    const store = await freshStore();
    const runtimeProject = createProject({
      'e2e.config.ts': RUNTIME_CONFIG,
      'tests/pass.e2e.ts': PASS_TEST,
    });
    const gateway = await start(store, ADMIN_TOKEN, runtimeProject);
    const { client, transport } = await connectHttp(gateway.url, MCP_TOKEN);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account({ url: app.url }))).status).toBe(201);

      const listed = await invoke(client, 'list_test_scripts');
      expect(listed.isError, listed.text).toBe(false);
      const result = JSON.parse(listed.text) as {
        scripts: { path: string }[];
        targets: { name: string; description?: string; enabled?: boolean }[];
      };
      expect(result.scripts.map((script) => script.path)).toContain('tests/pass.e2e.ts');
      expect(result.targets.map((target) => target.name)).toEqual(['base', 'oa-pc-main']);
      // The collected view carried the account too; its pool entry replaces it.
      expect(result.targets.find((target) => target.name === 'oa-pc-main')).toMatchObject({
        description: 'OA 电脑端 主账号',
        enabled: true,
      });
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
      runtimeProject.cleanup();
    }
  }, 120_000);

  it('opens a session on the account a description selects', async () => {
    const store = await freshStore(app.url);
    const accountProject = createProject({ 'e2e.config.ts': RUNTIME_CONFIG });
    const gateway = await start(store, ADMIN_TOKEN, accountProject);
    const { client, transport } = await connectHttp(gateway.url, MCP_TOKEN);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account({ url: app.url }))).status).toBe(201);

      const open = (await client.listTools()).tools.find((tool) => tool.name === 'open_session') as
        | { inputSchema?: { properties?: Record<string, unknown> } }
        | undefined;
      expect(open?.inputSchema?.properties).toHaveProperty('accountDescription');

      const opened = (await client.callTool(
        { name: 'open_session', arguments: { accountDescription: 'OA 电脑端 主账号' } },
        { timeout: 120_000 },
      )) as { isError?: boolean; structuredContent?: { target?: string } };
      expect(opened.isError).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({ target: 'oa-pc-main' });
      // The child's config read the runtime file the gateway generated for it.
      const runtime = JSON.parse(await readFile(path.join(store.dir, 'runtime-targets.json'), 'utf8')) as {
        name: string;
      }[];
      expect(runtime.map((entry) => entry.name)).toEqual(['base', 'oa-pc-main']);

      const conflict = await invoke(client, 'open_session', { target: 'oa-pc-main', accountDescription: '主账号' });
      expect(conflict.isError).toBe(true);
      expect(conflict.text).toContain('ACCOUNT_SELECTION_CONFLICT');
      const conflictWithBlank = await invoke(client, 'open_session', { target: 'oa-pc-main', accountDescription: ' ' });
      expect(conflictWithBlank.text).toContain('ACCOUNT_SELECTION_CONFLICT');
      expect(gateway.stderr()).not.toContain(PASSWORD);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
      accountProject.cleanup();
    }
  });

  it('runs on the account a description selects, through the generated runtime targets', async () => {
    const store = await freshStore(app.url);
    const runtimeProject = createProject({ 'e2e.config.ts': RUNTIME_CONFIG, 'tests/pass.e2e.ts': PASS_TEST });
    const gateway = await startJobs(store, runtimeProject);
    const { client, transport } = await connectHttp(gateway.url, MCP_TOKEN);
    try {
      expect(
        (await admin(gateway, 'POST', '/admin/api/accounts', account({ url: app.url }))).status,
      ).toBe(201);

      // Case and punctuation split the same way, and every word must match.
      const submitted = await invoke(client, 'run_test', {
        accountDescription: 'OA, 主账号',
        testFiles: ['tests/pass.e2e.ts'],
        idempotencyKey: 'by-description',
      });
      expect(submitted.isError, submitted.text).toBe(false);
      const job = JSON.parse(submitted.text) as { jobId: string; targetId: string };
      expect(job.targetId).toBe('oa-pc-main');

      // The same key and files on the resolved target name return the first job.
      const replay = await invoke(client, 'run_test', {
        targetId: 'oa-pc-main',
        testFiles: ['tests/pass.e2e.ts'],
        idempotencyKey: 'by-description',
      });
      expect(replay.isError, replay.text).toBe(false);
      expect((JSON.parse(replay.text) as { jobId: string }).jobId).toBe(job.jobId);

      const status = await waitForJob(client, job.jobId);
      expect(status['status'], JSON.stringify(status)).toBe('passed');
      expect(status['targetId']).toBe('oa-pc-main');
      const report = JSON.parse((await invoke(client, 'get_test_report', { jobId: job.jobId })).text) as {
        targetId: string;
        results: { status: string }[];
      };
      expect(report.targetId).toBe('oa-pc-main');
      expect(report.results[0]?.status).toBe('passed');

      const runtimeText = await readFile(path.join(store.dir, 'runtime-targets.json'), 'utf8');
      const runtime = JSON.parse(runtimeText) as { name: string; password?: string }[];
      expect(runtime.map((entry) => entry.name)).toEqual(['base', 'oa-pc-main']);
      const passwordRef = ['E2E_ACCOUNT', 'OA_PC_MAIN', 'PASSWORD'].join('_');
      expect(runtime.find((entry) => entry.name === 'oa-pc-main')!.password).toBe(`{{${passwordRef}}}`);
      expect(runtimeText).not.toContain(PASSWORD);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
      runtimeProject.cleanup();
    }
  });

  it('refuses to generate runtime targets when the base targets file is gone', async () => {
    const store = await freshStore(app.url);
    const runtimeProject = createProject({ 'e2e.config.ts': RUNTIME_CONFIG, 'tests/pass.e2e.ts': PASS_TEST });
    const gateway = await startJobs(store, runtimeProject);
    const { client, transport } = await connectHttp(gateway.url, MCP_TOKEN);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account({ url: app.url }))).status).toBe(201);
      await rm(store.baseFile);

      const submitted = await invoke(client, 'run_test', {
        accountDescription: 'OA 电脑端 主账号',
        testFiles: ['tests/pass.e2e.ts'],
      });
      expect(submitted.isError).toBe(true);
      expect(submitted.text).toContain('ACCOUNT_STORE_INVALID');
      expect(submitted.text).toContain('base targets file');
      await expect(stat(path.join(store.dir, 'runtime-targets.json'))).rejects.toThrow();
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
      runtimeProject.cleanup();
    }
  });

  it('refuses a description that is missing, ambiguous, disabled, or paired with a target', async () => {
    const store = await freshStore();
    const gateway = await startJobs(store, project);
    const { client, transport } = await connectHttp(gateway.url, MCP_TOKEN);
    try {
      expect((await admin(gateway, 'POST', '/admin/api/accounts', account())).status).toBe(201);
      expect(
        (await admin(gateway, 'POST', '/admin/api/accounts', account({ name: 'oa-pc-backup', description: 'OA 电脑端 备用账号' })))
          .status,
      ).toBe(201);
      expect((await admin(gateway, 'PATCH', '/admin/api/accounts/oa-pc-backup', { enabled: false })).status).toBe(200);
      expect(
        (await admin(gateway, 'POST', '/admin/api/accounts', account({ name: 'oa-moa-main', description: 'MOA 电脑端 主账号' })))
          .status,
      ).toBe(201);

      const run = async (args: Record<string, unknown>): Promise<string> =>
        (await invoke(client, 'run_test', { testFiles: ['tests/pass.e2e.ts'], ...args })).text;

      const both = await run({ targetId: 'web', accountDescription: 'OA 主账号' });
      expect(both).toContain('ACCOUNT_SELECTION_CONFLICT');
      const bothWithBlank = await run({ targetId: 'web', accountDescription: ' ' });
      expect(bothWithBlank).toContain('ACCOUNT_SELECTION_CONFLICT');
      const neither = await run({});
      expect(neither).toContain('targetId or accountDescription');
      const missing = await run({ accountDescription: '没有这个账号' });
      expect(missing).toContain('ACCOUNT_NOT_FOUND');
      const ambiguous = await run({ accountDescription: '电脑端' });
      expect(ambiguous).toContain('ACCOUNT_AMBIGUOUS');
      expect(ambiguous).toContain('oa-pc-main');
      expect(ambiguous).toContain('oa-moa-main');
      expect(ambiguous).toContain('OA 电脑端 主账号');
      const disabled = await run({ accountDescription: '备用账号' });
      expect(disabled).toContain('ACCOUNT_DISABLED');
      expect(disabled).toContain('oa-pc-backup');
      // A name is not a description: its hyphen-separated words do not match.
      const byName = await run({ accountDescription: 'oa-pc-main' });
      expect(byName).toContain('ACCOUNT_NOT_FOUND');

      await expect(stat(path.join(store.dir, 'runtime-targets.json'))).rejects.toThrow();
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('serializes concurrent writes so the file stays whole and one name wins once', async () => {
    const store = await freshStore();
    const gateway = await start(store);
    try {
      const distinct = await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((name) =>
          admin(gateway, 'POST', '/admin/api/accounts', account({ name: `account-${name}`, description: `账号 ${name}` })),
        ),
      );
      expect(distinct.map((entry) => entry.status)).toEqual([201, 201, 201, 201, 201]);
      const raced = await Promise.all(
        [0, 1, 2].map(() => admin(gateway, 'POST', '/admin/api/accounts', account({ name: 'same-name', description: '同名账号' }))),
      );
      expect(raced.map((entry) => entry.status).toSorted()).toEqual([201, 400, 400]);
      const document = JSON.parse((await files(store)).accounts) as { accounts: { name: string }[] };
      expect(document.accounts.map((entry) => entry.name).toSorted()).toEqual([
        'account-a',
        'account-b',
        'account-c',
        'account-d',
        'account-e',
        'same-name',
      ]);
    } finally {
      await gateway.close();
    }
  });
});
