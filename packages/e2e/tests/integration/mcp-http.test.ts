/**
 * `e2e mcp --http` end to end: the built CLI serving a fixture project over
 * Streamable HTTP to real MCP clients. The gateway keeps one native stdio
 * child per MCP session, authenticates every request with a Bearer token, and
 * binds each session to the principal that opened it.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { connectHttp, health, invoke, isRunning, startGateway, type Gateway } from '../helpers/http-gateway.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const TOKEN_A = 'test-token-alpha-0123456789abcdef';
const TOKEN_B = 'test-token-bravo-0123456789abcdef';
const TOKEN_C = 'test-token-charlie-0123456789abcdef';
const TOKEN_D = 'test-token-delta-0123456789abcdefgh';

const CONFIG = `import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 1,
  retries: 0,
  timeout: 15000,
};
`;

/** Two targets on one host, so opening the second lands in the first one's quota bucket. */
const TWO_TARGETS_CONFIG = `import { web } from '@e2e-dev/web';

export default {
  targets: [
    { name: 'web', engine: web(), app: { url: process.env.APP_URL! } },
    { name: 'web-2', engine: web(), app: { url: process.env.APP_URL! } },
  ],
  workers: 1,
  retries: 0,
  timeout: 15000,
};
`;

/** A config that records what it sees in its own process, then behaves normally. */
const ENV_PROBE_CONFIG = `import { writeFileSync } from 'node:fs';
import { web } from '@e2e-dev/web';

writeFileSync('child-env.json', String(process.env.E2E_HTTP_MCP_TOKENS ?? ''));

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  workers: 1,
  retries: 0,
  timeout: 15000,
};
`;

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-test', version: '0' } },
});

/** A successful initialize over fetch, leaving the response stream cancelled. */
async function initializeRaw(url: string, token: string): Promise<{ status: number; sessionId: string | undefined }> {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: INITIALIZE,
    signal: controller.signal,
  });
  const sessionId = response.headers.get('mcp-session-id') ?? undefined;
  await response.body?.cancel().catch(() => undefined);
  controller.abort();
  return { status: response.status, sessionId };
}

interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
}

/** A request with full control over headers, including Host and Origin. */
function raw(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: options.method ?? 'GET',
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
      },
    );
    outgoing.on('error', reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

describe('e2e mcp --http', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({
      'e2e.config.ts': CONFIG,
      'tests/sample.e2e.ts': `import { expect, test } from 'e2e';

test('sample passes', async () => {
  expect(1).toBe(1);
});
`,
    });
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('serves the four native tools and the guide resources to an authorized HTTP client', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha' }]);
    const { client, transport } = await connectHttp(gateway.url, TOKEN_A);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        'open_session',
        'tools',
        'call',
        'close_session',
        'list_test_scripts',
        'get_test_script',
      ]);
      expect(client.getInstructions()).toContain('Call open_session');
      // Saving a script is an explicit grant, not part of the default set.
      const refused = await invoke(client, 'save_test_script', { path: 'tests/new.e2e.ts', content: 'x' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('POLICY_DENIED');

      const { resources } = await client.listResources();
      expect(resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(['e2e://guide', 'e2e://guide/mcp', 'e2e://guide/writing-tests']),
      );
      const guide = await client.readResource({ uri: 'e2e://guide/mcp' });
      expect((guide.contents[0] as { text: string }).text).toContain('# Driving the app over MCP');
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
    }
  });

  it('lists, reads, and atomically saves scripts for a script-only token, with no native child', async () => {
    const gateway = await startGateway(project, app, [
      { token: TOKEN_B, principal: 'bravo', tools: ['list_test_scripts', 'get_test_script', 'save_test_script'] },
    ]);
    const { client, transport } = await connectHttp(gateway.url, TOKEN_B);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['list_test_scripts', 'get_test_script', 'save_test_script']);

      const listed = await invoke(client, 'list_test_scripts');
      expect(listed.isError, listed.text).toBe(false);
      const catalogue = JSON.parse(listed.text) as {
        scripts: { path: string; tests: { title: string; target: string; agent: string; tags: string[] }[] }[];
        total: number;
      };
      expect(catalogue.scripts.find((script) => script.path === 'tests/sample.e2e.ts')?.tests).toEqual([
        { title: 'sample passes', target: 'web', agent: 'default', tags: [] },
      ]);

      const read = await invoke(client, 'get_test_script', { path: 'tests/sample.e2e.ts' });
      expect(read.isError, read.text).toBe(false);
      expect((JSON.parse(read.text) as { content: string }).content).toContain('sample passes');

      const content = `import { expect, test } from 'e2e';

test('added passes', async () => {
  expect(2).toBe(2);
});
`;
      const saved = await invoke(client, 'save_test_script', { path: './tests/added.e2e.ts', content });
      expect(saved.isError, saved.text).toBe(false);
      expect(JSON.parse(saved.text)).toEqual({ path: 'tests/added.e2e.ts', bytes: Buffer.byteLength(content), created: true });
      expect(readFileSync(path.join(project.dir, 'tests', 'added.e2e.ts'), 'utf8')).toBe(content);

      // Collection reads the file that was saved a moment ago.
      const added = await invoke(client, 'list_test_scripts', { prefix: 'tests/added' });
      expect((JSON.parse(added.text) as { scripts: { path: string }[] }).scripts.map((script) => script.path)).toEqual([
        'tests/added.e2e.ts',
      ]);

      const exists = await invoke(client, 'save_test_script', { path: 'tests/added.e2e.ts', content });
      expect(exists.isError).toBe(true);
      expect(exists.text).toContain('SCRIPT_EXISTS');

      const escaped = await invoke(client, 'save_test_script', { path: '../escaped.e2e.ts', content });
      expect(escaped.isError).toBe(true);
      expect(escaped.text).toContain('POLICY_DENIED');

      // Script tools never start the native stdio server.
      expect(gateway.stderr()).not.toContain('child ready');
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
    }
  }, 90_000);

  it('lists and reads paths relative to a --test-root below the project root', async () => {
    const gateway = await startGateway(
      project,
      app,
      [{ token: TOKEN_B, principal: 'bravo', tools: ['list_test_scripts', 'get_test_script'] }],
      ['--test-root', 'tests'],
    );
    const { client, transport } = await connectHttp(gateway.url, TOKEN_B);
    try {
      const listed = await invoke(client, 'list_test_scripts');
      expect(listed.isError, listed.text).toBe(false);
      const catalogue = JSON.parse(listed.text) as { scripts: { path: string }[] };
      const paths = catalogue.scripts.map((script) => script.path);
      // The collection reports files from the project root; the list reports
      // them from the test root.
      expect(paths).toContain('sample.e2e.ts');
      expect(paths.every((file) => !file.startsWith('tests/'))).toBe(true);

      const read = await invoke(client, 'get_test_script', { path: 'sample.e2e.ts' });
      expect(read.isError, read.text).toBe(false);
      expect((JSON.parse(read.text) as { content: string }).content).toContain('sample passes');

      const above = await invoke(client, 'get_test_script', { path: '../outside.e2e.ts' });
      expect(above.isError).toBe(true);
      expect(above.text).toContain('POLICY_DENIED');
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
      await gateway.close();
    }
  }, 90_000);

  it('keeps two MCP sessions of the same principal on separate pages and closes both cleanly', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha' }]);
    const first = await connectHttp(gateway.url, TOKEN_A);
    const second = await connectHttp(gateway.url, TOKEN_A);
    try {
      const openedFirst = await invoke(first.client, 'open_session');
      expect(openedFirst.isError, openedFirst.text).toBe(false);
      const firstSession = /^Session (\S+) open/.exec(openedFirst.text)![1]!;
      const openedSecond = await invoke(second.client, 'open_session');
      expect(openedSecond.isError, openedSecond.text).toBe(false);
      const secondSession = /^Session (\S+) open/.exec(openedSecond.text)![1]!;
      expect(secondSession).not.toBe(firstSession);

      const navigated = await invoke(first.client, 'call', { tool: 'navigate', args: { url: '/storage' } });
      expect(navigated.isError, navigated.text).toBe(false);
      const firstScreen = await invoke(first.client, 'call', { tool: 'observe' });
      const save = /#(n\d+) button "Save marker"/.exec(firstScreen.text);
      expect(save, firstScreen.text).not.toBeNull();
      const tapped = await invoke(first.client, 'call', { tool: 'tap', args: { target: save![1]! } });
      expect(tapped.isError, tapped.text).toBe(false);
      const saved = await invoke(first.client, 'call', { tool: 'observe' });
      expect(saved.text).toContain('status "Marker" text="saved"');

      // The second MCP session has its own browser and never saw the marker.
      const secondNavigated = await invoke(second.client, 'call', { tool: 'navigate', args: { url: '/storage' } });
      expect(secondNavigated.isError, secondNavigated.text).toBe(false);
      const secondScreen = await invoke(second.client, 'call', { tool: 'observe' });
      expect(secondScreen.text).toContain('status "Marker" text="empty"');

      // Two calls on the first MCP session see the session it opened: the
      // child behind it is reused, not restarted per request.
      const listed = await invoke(first.client, 'tools');
      expect(listed.isError, listed.text).toBe(false);
      expect(listed.text).toContain(`Session ${firstSession} on target "web"`);
      const again = await invoke(first.client, 'tools');
      expect(again.text).toContain(`Session ${firstSession} on target "web"`);

      await first.transport.terminateSession();
      await second.transport.terminateSession();
      await first.client.close();
      await second.client.close();
      await expect.poll(async () => (await health(gateway.url)).sessions, { timeout: 20_000 }).toBe(0);
    } finally {
      await first.transport.terminateSession().catch(() => undefined);
      await second.transport.terminateSession().catch(() => undefined);
      await first.client.close().catch(() => undefined);
      await second.client.close().catch(() => undefined);
      await gateway.close();
    }
  }, 90_000);

  it('refuses unauthenticated, cross-principal, wrong-host, wrong-origin, and disallowed-tool calls', async () => {
    const gateway = await startGateway(project, app, [
      { token: TOKEN_A, principal: 'alpha' },
      { token: TOKEN_B, principal: 'bravo' },
      { token: TOKEN_C, principal: 'charlie', tools: ['open_session', 'call'] },
      { token: TOKEN_D, principal: 'alpha', tools: ['open_session'] },
    ]);
    const first = await connectHttp(gateway.url, TOKEN_A);
    const limited = await connectHttp(gateway.url, TOKEN_C);
    try {
      const opened = await invoke(first.client, 'open_session');
      expect(opened.isError, opened.text).toBe(false);
      const sessionId = first.transport.sessionId;
      expect(sessionId).toBeDefined();
      expect((await health(gateway.url)).sessions).toBe(2);

      const noToken = await raw(gateway.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: INITIALIZE,
      });
      expect(noToken.status).toBe(401);
      expect(noToken.headers['www-authenticate']).toContain('Bearer');
      const badToken = await raw(gateway.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${'x'.repeat(32)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: INITIALIZE,
      });
      expect(badToken.status).toBe(401);
      // Neither refused request opened a session or spawned an execution child.
      expect((await health(gateway.url)).sessions).toBe(2);

      const crossWrite = await raw(gateway.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_B}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'open_session', arguments: {} } }),
      });
      expect(crossWrite.status).toBe(403);
      const crossDelete = await raw(gateway.url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${TOKEN_B}`, 'mcp-session-id': sessionId! },
      });
      expect(crossDelete.status).toBe(403);
      // Same principal, another token: the session still belongs to the token
      // that opened it, whose tool set it froze at creation.
      const samePrincipal = await raw(gateway.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_D}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
      });
      expect(samePrincipal.status).toBe(403);
      const unknownSession = await raw(gateway.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': 'not-a-session',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      expect(unknownSession.status).toBe(404);
      // The owner still drives the session the refused requests named.
      const still = await invoke(first.client, 'tools');
      expect(still.isError, still.text).toBe(false);

      const wrongHost = await raw(gateway.url, { headers: { authorization: `Bearer ${TOKEN_A}`, host: 'evil.example' } });
      expect(wrongHost.status).toBe(403);
      const wrongOrigin = await raw(gateway.url, { headers: { authorization: `Bearer ${TOKEN_A}`, origin: 'http://evil.example' } });
      expect(wrongOrigin.status).toBe(403);

      const listed = await limited.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['open_session', 'call']);
      const denied = await invoke(limited.client, 'tools');
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('POLICY_DENIED');
      const limitedOpen = await invoke(limited.client, 'open_session');
      expect(limitedOpen.isError, limitedOpen.text).toBe(false);

      await limited.transport.terminateSession();
      await limited.client.close();
      await expect.poll(async () => (await health(gateway.url)).sessions, { timeout: 20_000 }).toBe(1);
      await first.transport.terminateSession();
      await first.client.close();
      await expect.poll(async () => (await health(gateway.url)).sessions, { timeout: 20_000 }).toBe(0);
    } finally {
      await limited.transport.terminateSession().catch(() => undefined);
      await first.transport.terminateSession().catch(() => undefined);
      await limited.client.close().catch(() => undefined);
      await first.client.close().catch(() => undefined);
      await gateway.close();
    }
  }, 120_000);

  it('reclaims an idle session after its TTL, without a child for a session that never called a tool', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha' }], ['--session-ttl', '2']);
    try {
      const initialized = await initializeRaw(gateway.url, TOKEN_A);
      expect(initialized.status).toBe(200);
      expect(initialized.sessionId).toBeDefined();
      expect((await health(gateway.url)).sessions).toBe(1);
      expect(gateway.stderr()).not.toContain('child ready');
      await expect.poll(async () => (await health(gateway.url)).sessions, { timeout: 10_000, interval: 200 }).toBe(0);
      const stale = await raw(gateway.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': initialized.sessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(stale.status).toBe(404);
    } finally {
      await gateway.close();
    }
  }, 30_000);

  it('closes an abandoned exploration session on the TTL, child and browser included', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha' }], ['--session-ttl', '2']);
    const { client } = await connectHttp(gateway.url, TOKEN_A);
    try {
      const opened = await invoke(client, 'open_session');
      expect(opened.isError, opened.text).toBe(false);
      expect((await health(gateway.url)).sessions).toBe(1);
      expect(gateway.stderr()).toContain('child ready');
      const pid = Number(/child ready \(pid (\d+)\)/.exec(gateway.stderr())?.[1]);
      expect(Number.isInteger(pid), gateway.stderr()).toBe(true);
      // A client that closes without DELETE leaves no connection to watch.
      await client.close();
      await expect.poll(async () => (await health(gateway.url)).sessions, { timeout: 20_000, interval: 200 }).toBe(0);
      // The slot frees before the child finishes closing, so the log line lags.
      await expect.poll(() => gateway.stderr().includes('idle timeout'), { timeout: 10_000, interval: 200 }).toBe(true);
      // The TTL closed the child itself, not only its slot.
      await expect.poll(() => !isRunning(pid), { timeout: 10_000, interval: 200 }).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await gateway.close();
    }
  }, 40_000);

  it('answers an oversized request with 413 and keeps no session for it', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha' }], ['--max-body', '1024']);
    try {
      const oversized = await raw(gateway.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          ...JSON.parse(INITIALIZE),
          params: { ...JSON.parse(INITIALIZE).params, clientInfo: { name: 'x'.repeat(2048), version: '0' } },
        }),
      });
      expect(oversized.status).toBe(413);
      await expect.poll(async () => (await health(gateway.url)).sessions, { timeout: 10_000, interval: 200 }).toBe(0);
    } finally {
      await gateway.close();
    }
  }, 30_000);

  it('refuses --max-sessions together with --http', async () => {
    await expect(startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha' }], ['--max-sessions', '1'])).rejects.toThrow(
      /--max-sessions applies to stdio.*--max-sessions-per-domain/,
    );
  }, 30_000);

  it('serves more sessions than the old global cap', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha' }]);
    const clients: Awaited<ReturnType<typeof connectHttp>>[] = [];
    try {
      for (let index = 0; index < 3; index += 1) clients.push(await connectHttp(gateway.url, TOKEN_A));
      expect((await health(gateway.url)).sessions).toBe(3);
    } finally {
      for (const { client, transport } of clients) {
        await transport.terminateSession().catch(() => undefined);
        await client.close().catch(() => undefined);
      }
      await gateway.close();
    }
  }, 30_000);

  it('reclaims the least recently active session of the same user and domain', async () => {
    const quotaProject = createProject({ 'e2e.config.ts': TWO_TARGETS_CONFIG });
    const gateway = await startGateway(quotaProject, app, [{ token: TOKEN_A, principal: 'alpha' }], ['--max-sessions-per-domain', '1']);
    const first = await connectHttp(gateway.url, TOKEN_A);
    let second: Awaited<ReturnType<typeof connectHttp>> | undefined;
    try {
      const openedFirst = (await first.client.callTool({ name: 'open_session', arguments: { target: 'web' } }, { timeout: 120_000 })) as {
        isError?: boolean;
        structuredContent?: { target?: string; platform?: string; appUrl?: string };
      };
      expect(openedFirst.isError).not.toBe(true);
      expect(openedFirst.structuredContent).toMatchObject({ target: 'web', platform: 'web' });
      const appUrl = openedFirst.structuredContent?.appUrl;
      expect(typeof appUrl).toBe('string');
      expect(new URL(String(appUrl)).host).toBe(new URL(app.url).host);

      second = await connectHttp(gateway.url, TOKEN_A);
      const openedSecond = (await second.client.callTool({ name: 'open_session', arguments: { target: 'web-2' } }, { timeout: 120_000 })) as {
        isError?: boolean;
        structuredContent?: { target?: string };
      };
      expect(openedSecond.isError).not.toBe(true);
      expect(openedSecond.structuredContent).toMatchObject({ target: 'web-2' });

      // The reclaimed session is out of the slot at once, though its child is still stopping.
      await expect.poll(async () => (await health(gateway.url)).sessions, { timeout: 20_000, interval: 200 }).toBe(1);
      await expect(first.client.listTools()).rejects.toThrow();
      expect(gateway.stderr()).toContain('reclaimed for');
    } finally {
      await second?.transport.terminateSession().catch(() => undefined);
      await second?.client.close().catch(() => undefined);
      await first.transport.terminateSession().catch(() => undefined);
      await first.client.close().catch(() => undefined);
      await gateway.close();
      // The browser can hold files under the project for a moment after the
      // session closes; Windows refuses the removal until it lets go.
      await expect.poll(() => {
        try {
          quotaProject.cleanup();
          return true;
        } catch {
          return false;
        }
      }).toBe(true);
    }
  }, 120_000);

  // Windows environment names are case-insensitive: a token set in another
  // spelling must still stay out of the child that runs project code.
  it.skipIf(process.platform !== 'win32')('strips a differently spelled token variable from the child environment', async () => {
    const probe = createProject({ 'e2e.config.ts': ENV_PROBE_CONFIG });
    let gateway: Gateway | undefined;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;
    try {
      gateway = await startGateway(probe, app, undefined, [], {
        e2e_http_mcp_tokens: JSON.stringify([{ token: TOKEN_A, principal: 'alpha' }]),
      });
      ({ client, transport } = await connectHttp(gateway.url, TOKEN_A));
      const opened = await invoke(client, 'open_session');
      expect(opened.isError, opened.text).toBe(false);
      expect(await readFile(path.join(probe.dir, 'child-env.json'), 'utf8')).toBe('');
      expect(gateway.stderr()).not.toContain(TOKEN_A);
    } finally {
      await transport?.terminateSession().catch(() => undefined);
      await client?.close().catch(() => undefined);
      await gateway?.close();
      // The browser can hold files under the project for a moment after the
      // session closes; Windows refuses the removal until it lets go.
      await expect.poll(() => {
        try {
          probe.cleanup();
          return true;
        } catch {
          return false;
        }
      }, { timeout: 30_000, interval: 500 }).toBe(true);
    }
  }, 90_000);

  it('honors an explicit Host and Origin allowlist and shuts down with code 0', async () => {
    const gateway = await startGateway(project, app, [{ token: TOKEN_A, principal: 'alpha' }], [
      '--allow-host',
      'example.test',
      '--allow-origin',
      'http://example.test',
    ]);
    try {
      const allowed = await raw(new URL('/healthz', gateway.url).href, {
        headers: { host: 'example.test', origin: 'http://example.test' },
      });
      expect(allowed.status).toBe(200);
      const loopback = await raw(new URL('/healthz', gateway.url).href, { headers: {} });
      expect(loopback.status).toBe(403);
      const wrongOrigin = await raw(new URL('/healthz', gateway.url).href, {
        headers: { host: 'example.test', origin: 'http://other.test' },
      });
      expect(wrongOrigin.status).toBe(403);
    } finally {
      await gateway.close();
    }
    // Windows delivers SIGTERM as an unconditional kill, so only POSIX sees
    // the CLI's own 0; on both, close() waits for the process to be gone.
    expect(gateway.child.exitCode !== null || gateway.child.signalCode !== null).toBe(true);
    if (process.platform !== 'win32') expect(gateway.child.exitCode).toBe(0);
  }, 30_000);
});
