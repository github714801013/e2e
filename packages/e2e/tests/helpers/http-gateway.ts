/**
 * Shared harness for the `e2e mcp --http` integration tests: spawn the built
 * CLI as a gateway, connect a real MCP client over Streamable HTTP, and call
 * one tool.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FixtureApp } from './fixture-app.ts';
import type { FixtureProject } from './run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

export interface Gateway {
  readonly url: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: () => string;
  close(): Promise<void>;
}

/** Starts the built CLI in HTTP mode and waits for its listening line. */
export async function startGateway(
  project: FixtureProject,
  app: FixtureApp,
  tokens: unknown,
  extraArgs: readonly string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<Gateway> {
  const child = spawn(
    process.execPath,
    [CLI, 'mcp', '--http', '--port', '0', '--config', 'e2e.config.ts', ...extraArgs],
    {
      cwd: project.dir,
      env: {
        ...(process.env as Record<string, string>),
        APP_URL: app.url,
        CI: '',
        ...(tokens === undefined ? {} : { E2E_HTTP_MCP_TOKENS: JSON.stringify(tokens) }),
        ...extraEnv,
      },
      stdio: 'pipe',
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', () => undefined);
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway did not listen:\n${stderr}`)), 30_000);
    child.stderr.on('data', () => {
      const match = /listening on (http:\/\/\S+)/.exec(stderr);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway exited with ${String(code)}:\n${stderr}`));
    });
  });
  return {
    url,
    child,
    stderr: () => stderr,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      // The gateway stops runs one at a time: 20 s grace plus a 5 s hard kill
      // each, so two runs can take 50 s. The budget leaves room for that.
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 60_000).unref())]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

export async function connectHttp(url: string, token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'e2e-http-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, transport };
}

export interface ToolText {
  readonly text: string;
  readonly isError: boolean;
}

export async function invoke(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolText> {
  const result = (await client.callTool({ name, arguments: args }, { timeout: 60_000 })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  return {
    text: result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'),
    isError: result.isError === true,
  };
}

export async function health(url: string): Promise<{ status: string; sessions: number }> {
  const response = await fetch(new URL('/healthz', url));
  if (response.status !== 200) throw new Error(`healthz answered ${response.status}`);
  return (await response.json()) as { status: string; sessions: number };
}

/** Whether a pid still names a live process. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
