/**
 * The shared login through `e2e mcp`: a test submitted with `run_test` runs
 * under it, and an interactive `open_session` never restores or signs in.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { connectHttp, invoke, startGateway } from '../helpers/http-gateway.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');
const TOKEN = 'shared-login-token-0123456789abcdef';

const JOB_TOOLS = ['run_test', 'get_test_status', 'get_test_report', 'list_test_artifacts'];

/** A fake-engine project whose target signs in by writing marker files under `process.cwd()`. */
const CONFIG = `import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const dir = path.join(process.cwd(), '.e2e');
const signedIn = path.join(dir, 'signed-in');

export default {
  targets: [
    {
      name: 'fake',
      platform: 'fake',
      engine: createFakeEngine({ state: true }).engine,
      app: FAKE_APP,
      session: {
        account: 'tester',
        login: async () => {
          mkdirSync(signedIn, { recursive: true });
          appendFileSync(path.join(dir, 'logins.txt'), 'login\\n');
        },
        check: async () => {
          appendFileSync(path.join(dir, 'checks.txt'), 'check\\n');
          return existsSync(signedIn);
        },
      },
    },
  ],
  credentials: { tester: { username: 'tester@example.test', password: 'pw-mcp-shared' } },
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
`;

const files = {
  'e2e.config.ts': CONFIG,
  'tests/plain.e2e.ts': `import { test } from 'e2e';
test('runs under the shared login', async () => {});`,
};

/** The lines of one marker file, or none when nothing wrote it. */
function markers(project: FixtureProject, name: string): number {
  const file = path.join(project.dir, '.e2e', name);
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

describe('shared login through e2e mcp', { timeout: 180_000 }, () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('runs a submitted test under the shared login, logging in once', async () => {
    const project = createProject(files);
    const gateway = await startGateway(project, app, [{ token: TOKEN, principal: 'alpha', tools: JOB_TOOLS }]);
    try {
      const { client } = await connectHttp(gateway.url, TOKEN);
      const submitted = await invoke(client, 'run_test', { targetId: 'fake', testFiles: ['tests/plain.e2e.ts'] });
      expect(submitted.isError, submitted.text).toBe(false);
      const { jobId } = JSON.parse(submitted.text) as { jobId: string };
      await expect
        .poll(
          async () => {
            const status = JSON.parse((await invoke(client, 'get_test_status', { jobId })).text) as { status: string };
            return status.status;
          },
          { timeout: 120_000, interval: 500 },
        )
        .toBe('passed');
      expect(markers(project, 'logins.txt')).toBe(1);
      expect(markers(project, 'checks.txt')).toBe(1);
    } finally {
      await gateway.close();
      project.cleanup();
    }
  });

  it('leaves an interactive session signed out', async () => {
    const project = createProject(files);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      cwd: project.dir,
      env: { ...(process.env as Record<string, string>), CI: '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e-mcp-shared-login', version: '0.0.0' });
    try {
      await client.connect(transport);
      const opened = await invoke(client, 'open_session', {});
      expect(opened.isError, opened.text).toBe(false);
      await invoke(client, 'close_session', {});
      expect(markers(project, 'logins.txt')).toBe(0);
      expect(markers(project, 'checks.txt')).toBe(0);
    } finally {
      await client.close().catch(() => undefined);
      project.cleanup();
    }
  });
});
