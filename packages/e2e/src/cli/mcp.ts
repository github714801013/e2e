/**
 * The `e2e mcp` command: claims stdout for the protocol, then serves. Over
 * stdio, stdout is the JSON-RPC stream, so anything else that writes there
 * (a stray console.log, a library banner) would corrupt the handshake. The
 * transport keeps the process's own stdout writer, and everything else that
 * reaches process.stdout or process.stderr goes to stderr, redacted, for the
 * whole process: user code runs here and may print a secret.
 */

import { Writable } from 'node:stream';
import { ConfigurationError, errorMessage, exitCodeForCategory, classifyError } from '../internal/errors.ts';
import { SESSION_PER_DOMAIN_BOUNDS } from '../mcp/http/config.ts';
import { McpOutput } from '../mcp/output.ts';
import { serveMcp, type ServeOptions } from '../mcp/server.ts';
import { processSecrets } from '../run/secrecy.ts';
import { mcpSessionEvent } from '../telemetry/events.ts';
import type { Telemetry } from '../telemetry/telemetry.ts';

export interface McpCommandOptions {
  config?: string | undefined;
  target?: string | undefined;
  headed?: boolean | undefined;
  maxSessions?: number | undefined;
  /** Sessions one principal may hold on one target domain over HTTP. */
  maxSessionsPerDomain?: number | undefined;
  /** Serve Streamable HTTP instead of stdio. */
  http?: boolean | undefined;
  host?: string | undefined;
  /** 0 asks the OS for a free port. */
  port?: number | undefined;
  path?: string | undefined;
  allowHost?: string[] | undefined;
  allowOrigin?: string[] | undefined;
  trustedProxy?: string[] | undefined;
  /** Idle timeout in seconds; 0 keeps idle sessions open. */
  sessionTtl?: number | undefined;
  maxBody?: number | undefined;
  /** Workers one HTTP job run may start; defaults to four. */
  maxWorkers?: number | undefined;
  /** Test runs the gateway serves at once; defaults to two. */
  maxRuns?: number | undefined;
  /** Directory the script tools resolve paths against; defaults to `cwd`. */
  testRoot?: string | undefined;
}

/**
 * Takes over the process's stdout and stderr: the returned protocol stream
 * still reaches the real stdout, and every other write to either stream goes
 * through `output` to stderr. The protocol stream wraps the original writer
 * rather than opening file descriptor 1 again: once Node has set up
 * `process.stdout` on a pipe, the descriptor is non-blocking, and a plain
 * `fs` write to it fails with EAGAIN as soon as the client reads slower than
 * the server writes (a screenshot result), killing the server. The socket
 * writer queues and retries instead.
 */
function claimStdio(): { protocol: Writable; output: McpOutput } {
  const stdout = process.stdout;
  const stderr = process.stderr;
  const writeStdout = stdout.write.bind(stdout) as (chunk: Buffer, callback: (error?: Error | null) => void) => boolean;
  const writeStderr = stderr.write.bind(stderr) as (chunk: string, callback?: () => void) => boolean;
  const output = new McpOutput(writeStderr, processSecrets);
  for (const [stream, name] of [
    [stdout, 'stdout'],
    [stderr, 'stderr'],
  ] as const) {
    stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean => {
      const done = typeof encoding === 'function' ? encoding : callback;
      const text = typeof chunk === 'string' && typeof encoding === 'string' ? Buffer.from(chunk, encoding) : chunk;
      const accepted = output.write(name, text, done);
      // stderr drains on its own; a writer waiting on stdout is told when stderr has.
      if (!accepted && stream === stdout) stderr.once('drain', () => stdout.emit('drain'));
      return accepted;
    }) as typeof stream.write;
  }
  const protocol = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      writeStdout(chunk, callback);
    },
  });
  // A client that went away fails the pipe with EPIPE; the protocol stream
  // carries the error to the server, which closes its sessions and exits.
  // A client that captured stderr takes that pipe with it too, and the
  // diagnostics written while the sessions close must not kill the server
  // before its app processes stop.
  stdout.on('error', (error) => protocol.destroy(error));
  stderr.on('error', () => undefined);
  return { protocol, output };
}

/**
 * Records each MCP session as it ends and sends it at once: a server lives
 * as long as its client, and one its client kills never reaches the flush
 * at exit.
 */
export function sessionTelemetry(telemetry: Telemetry): NonNullable<ServeOptions['onSessionEnd']> {
  return (summary, client) => {
    telemetry.record(mcpSessionEvent(summary, client));
    void telemetry.sendQueued();
  };
}

/** Runs the server until the client disconnects or a signal arrives; returns the exit code. */
export async function mcp(version: string, options: McpCommandOptions, telemetry: Telemetry): Promise<number> {
  if (options.http === true) return mcpHttp(version, options);
  const { protocol, output } = claimStdio();
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  // Node would print an error nobody caught (a project tool's unawaited
  // promise) straight to the stderr descriptor, past the redaction, and
  // exit with every session's app still running. It is logged redacted, and
  // held like user output while a config loads, and the server shuts down as
  // on a signal.
  let crashed = false;
  const onUncaught = (cause: unknown): void => {
    crashed = true;
    const text = cause instanceof Error ? (cause.stack ?? errorMessage(cause)) : errorMessage(cause);
    output.report(`e2e mcp: [error] uncaught: ${text}`);
    stop.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // A rejection nobody handled arrives here too: with no `unhandledRejection` listener, Node raises it as uncaught.
  process.on('uncaughtException', onUncaught);
  try {
    const code = await serveMcp({
      cwd: process.cwd(),
      configPath: options.config,
      target: options.target,
      headed: options.headed === true,
      maxSessions: options.maxSessions,
      env: process.env,
      version,
      stdin: process.stdin,
      stdout: protocol,
      log: (line) => output.log(`e2e mcp: ${line}`),
      output,
      signal: stop.signal,
      onSessionEnd: sessionTelemetry(telemetry),
    });
    return crashed ? 1 : code;
  } catch (cause) {
    const error = classifyError(cause);
    output.log(`e2e mcp: ${error.code}: ${processSecrets.redact(errorMessage(cause))}`);
    return exitCodeForCategory(error.category);
  } finally {
    output.end();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('uncaughtException', onUncaught);
  }
}

/**
 * Serves Streamable HTTP until a signal arrives. Unlike stdio mode the
 * process owns no protocol stream, so diagnostics stay on stderr and project
 * code runs in the per-session children, never here.
 */
async function mcpHttp(version: string, options: McpCommandOptions): Promise<number> {
  // Loaded here, not at the top: the HTTP transport pulls in the MCP client
  // SDK, and `run`, `init`, and every other command would pay for it.
  const [{ loadHttpMcpTokens, normalizeAddress, httpPath }, { serveHttpMcp }] = await Promise.all([
    import('../mcp/http/config.ts'),
    import('../mcp/http/server.ts'),
  ]);
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  // A log consumer that closed its pipe must not take every session down.
  process.stderr.on('error', () => undefined);
  const log = (line: string): void => {
    process.stderr.write(`e2e mcp: ${line}\n`);
  };
  let crashed = false;
  const onUncaught = (cause: unknown): void => {
    crashed = true;
    const text = cause instanceof Error ? (cause.stack ?? errorMessage(cause)) : errorMessage(cause);
    log(`[error] uncaught: ${processSecrets.redact(text)}`);
    stop.abort();
  };
  process.on('uncaughtException', onUncaught);
  // Tests shorten the deadlines; the environment is not a supported flag.
  const runTimeoutMs = Number(process.env['E2E_HTTP_MCP_RUN_TIMEOUT_MS']);
  const jobTimeoutMs = Number(process.env['E2E_HTTP_MCP_JOB_TIMEOUT_MS']);
  const authTimeoutMs = Number(process.env['E2E_HTTP_MCP_AUTH_TIMEOUT_MS']);
  const retentionMs = Number(process.env['E2E_HTTP_MCP_RETENTION_MS']);
  const startupTimeoutMs = Number(process.env['E2E_HTTP_MCP_STARTUP_TIMEOUT_MS']);
  try {
    // The gateway has no global session cap: the per-domain quota bounds the
    // browsers, and a flag that silently stopped applying would mislead.
    if (options.maxSessions !== undefined) {
      throw new ConfigurationError('INVALID_ARGUMENT', '--max-sessions applies to stdio; over --http, use --max-sessions-per-domain');
    }
    const handle = await serveHttpMcp({
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 3001,
      path: httpPath(options.path),
      allowedHosts: options.allowHost,
      allowedOrigins: options.allowOrigin,
      trustedProxies: (options.trustedProxy ?? []).map(normalizeAddress),
      maxSessionsPerDomain: options.maxSessionsPerDomain ?? SESSION_PER_DOMAIN_BOUNDS.default,
      maxWorkers: options.maxWorkers,
      maxRuns: options.maxRuns,
      ...(Number.isSafeInteger(runTimeoutMs) && runTimeoutMs > 0 ? { runTimeoutMs } : {}),
      ...(Number.isSafeInteger(jobTimeoutMs) && jobTimeoutMs > 0 ? { jobTimeoutMs } : {}),
      ...(Number.isSafeInteger(authTimeoutMs) && authTimeoutMs > 0 ? { authTimeoutMs } : {}),
      ...(Number.isSafeInteger(retentionMs) && retentionMs > 0 ? { retentionMs } : {}),
      ...(Number.isSafeInteger(startupTimeoutMs) && startupTimeoutMs > 0 ? { startupTimeoutMs } : {}),
      sessionIdleMs: (options.sessionTtl ?? 600) * 1000,
      maxBodyBytes: options.maxBody ?? 4 * 1024 * 1024,
      tokens: loadHttpMcpTokens(process.env),
      testRoot: options.testRoot ?? process.cwd(),
      cwd: process.cwd(),
      configPath: options.config,
      target: options.target,
      headed: options.headed === true,
      version,
      env: process.env,
      cliEntry: cliEntry(),
      log,
      signal: stop.signal,
    });
    log(`listening on ${handle.url}`);
    if (stop.signal.aborted) await handle.close();
    await handle.closed;
    return crashed ? 1 : 0;
  } catch (cause) {
    const error = classifyError(cause);
    log(`${error.code}: ${processSecrets.redact(errorMessage(cause))}`);
    return exitCodeForCategory(error.category);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('uncaughtException', onUncaught);
  }
}

/** The CLI script this process runs, spawned as each HTTP session's stdio server. */
function cliEntry(): string {
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new ConfigurationError('INVALID_ARGUMENT', 'e2e mcp --http cannot find the CLI entry to start its sessions');
  }
  return entry;
}

