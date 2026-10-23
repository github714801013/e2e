/**
 * The `e2e mcp --http` gateway: Streamable HTTP in front of one `e2e mcp`
 * stdio child per MCP session. The socket is the trust boundary, so Host and
 * Origin are checked before the Bearer token, the token before a session is
 * created, and a session id is only usable by the principal that opened it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ConfigurationError, errorMessage } from '../../internal/errors.ts';
import { processSecrets } from '../../run/secrecy.ts';
import {
  authenticate,
  clientAddress,
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_WORKERS,
  defaultHosts,
  defaultOrigins,
  hostAllowed,
  isJobMcpTool,
  originAllowed,
  RUN_TIMEOUT_MS,
  type HttpMcpOptions,
} from './config.ts';
import { JobService } from './jobs.ts';
import { SessionQuota } from './quota.ts';
import { ScriptService } from './scripts.ts';
import { HttpSession, type SessionHooks } from './session.ts';

/** A running gateway; `closed` resolves after a signal or `close()`. */
export interface HttpMcpHandle {
  readonly url: string;
  readonly port: number;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Serves until `close()` or `options.signal`; resolves once listening. */
export async function serveHttpMcp(options: HttpMcpOptions): Promise<HttpMcpHandle> {
  const sessions = new Map<string, HttpSession>();
  /** Sessions being closed whose child is still stopping. */
  const closingSessions = new Set<Promise<void>>();
  const quota = new SessionQuota(options.maxSessionsPerDomain);
  const startedAt = Date.now();
  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const http = createServer();
  http.on('request', (request, response) => {
    void handle(request, response).catch((cause: unknown) => {
      options.log(`request failed: ${processSecrets.redact(errorMessage(cause))}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' });
      else response.destroy();
    });
  });

  // Created before binding: a test root the script tools cannot use is a
  // configuration failure, not something to discover on the first call.
  const scripts = await ScriptService.create({
    root: options.testRoot,
    configPath: options.configPath,
    cliEntry: options.cliEntry,
    env: options.env,
    log: options.log,
  });
  // Only a gateway that can hand out a job tool owns the job store and the
  // Runner children; every other gateway never creates `.e2e/http-jobs`.
  const jobs = options.tokens.some((token) => token.tools.some(isJobMcpTool))
    ? await JobService.create({
        cwd: options.cwd,
        configPath: options.configPath,
        env: options.env,
        maxWorkers: options.maxWorkers ?? DEFAULT_MAX_WORKERS,
        maxRuns: options.maxRuns ?? DEFAULT_MAX_RUNS,
        runTimeoutMs: options.runTimeoutMs ?? RUN_TIMEOUT_MS,
        ...(options.jobTimeoutMs === undefined ? {} : { jobTimeoutMs: options.jobTimeoutMs }),
        ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
        ...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
        ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
        log: options.log,
      })
    : undefined;
  await listen(http, options.host, options.port);
  const bound = http.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : options.port;
  // Defaults are computed after binding so `--port 0` allows exactly the
  // loopback names for the port the OS chose.
  const allowedHosts = options.allowedHosts ?? defaultHosts(port);
  const allowedOrigins = options.allowedOrigins ?? defaultOrigins(port);
  const displayHost = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host.includes(':') ? `[${options.host}]` : options.host;
  const url = `http://${displayHost}:${port}${options.path}`;

  const hooks: SessionHooks = {
    onInitialized: (id) => options.log(`session ${id} initialized`),
    onDeleted: (id) => {
      void closeById(id, 'client closed');
    },
    onChildGone: (id) => {
      void closeById(id, 'child exited');
    },
    onNativeResult: (id, name, result) => {
      if (result.isError === true) return;
      if (name === 'close_session') {
        quota.release(id);
        return;
      }
      if (name !== 'open_session') return;
      const session = sessions.get(id);
      if (session === undefined) return;
      const opened = openedTarget(result.structuredContent);
      if (opened === undefined) {
        options.log(`session ${id} opened a target without its structured metadata; the domain quota does not count it`);
        return;
      }
      const domain = domainOf(opened);
      const reclaimed = quota.occupy(id, session.token.principal, domain);
      if (reclaimed === undefined) return;
      options.log(`session ${reclaimed} reclaimed for "${session.token.principal}" on ${domain} (limit ${options.maxSessionsPerDomain})`);
      void closeById(reclaimed, 'reclaimed for its domain quota');
    },
  };

  function touch(session: HttpSession): void {
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = undefined;
    if (session.closing) return;
    if (session.inFlight === 0 && options.sessionIdleMs > 0) {
      session.timer = setTimeout(() => {
        void closeById(session.id, 'idle timeout');
      }, options.sessionIdleMs);
      session.timer.unref();
    }
  }

  /** A request, or the stream it keeps open, is activity: no idle reaping. */
  function begin(session: HttpSession): void {
    session.inFlight += 1;
    quota.touch(session.id);
    if (session.timer !== undefined) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
  }

  function end(session: HttpSession): void {
    session.inFlight -= 1;
    if (session.inFlight === 0) touch(session);
  }

  async function closeById(id: string, reason: string): Promise<void> {
    const session = sessions.get(id);
    if (session === undefined) return;
    // Drop the map entry at once: the id is already unusable (`closing`
    // answers 404), while the domain quota keeps counting the session until
    // its child stops.
    sessions.delete(id);
    const done = session.close();
    closingSessions.add(done);
    try {
      await done;
    } finally {
      closingSessions.delete(done);
      // A closing session still owns its browser until the child exits.
      quota.release(id);
    }
    options.log(`session ${id} closed (${reason})`);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) {
      sendJson(response, 503, { error: 'shutting_down' });
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const remote = clientAddress(
      request.socket.remoteAddress,
      header(request.headers['x-forwarded-for']),
      options.trustedProxies,
    );
    if (!hostAllowed(request.headers.host, allowedHosts) || !originAllowed(request.headers.origin, allowedOrigins)) {
      options.log(`${request.method ?? '?'} ${pathname} refused from ${remote}: host or origin not allowed`);
      sendJson(response, 403, { error: 'forbidden' });
      return;
    }
    if (pathname === '/healthz') {
      sendJson(response, 200, {
        status: 'ok',
        version: options.version,
        sessions: sessions.size,
        uptimeMs: Date.now() - startedAt,
      });
      return;
    }
    if (pathname !== options.path) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    const token = authenticate(request.headers.authorization, options.tokens);
    if (token === undefined) {
      options.log(`unauthorized ${request.method ?? '?'} ${pathname} from ${remote}`);
      response.setHeader('www-authenticate', 'Bearer realm="e2e mcp"');
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const sessionId = header(request.headers['mcp-session-id']);
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        sendJson(response, 404, { error: 'session_not_found' });
        return;
      }
      // Bound to the exact token, not only its principal: two tokens of one
      // principal can grant different tools, and a session keeps the set it
      // was opened with.
      if (session.token !== token) {
        options.log(`session ${sessionId} refused for principal "${token.principal}" from ${remote}`);
        sendJson(response, 403, { error: 'session_forbidden' });
        return;
      }
      if (session.closing) {
        sendJson(response, 404, { error: 'session_not_found' });
        return;
      }
      begin(session);
      try {
        await forward(request, response, session);
      } finally {
        end(session);
      }
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 400, { error: 'session_required' });
      return;
    }
    const session = new HttpSession(options, token, scripts, jobs, hooks);
    // Hold the slot before the first await, so two concurrent initializes
    // cannot both pass the limit check.
    sessions.set(session.id, session);
    try {
      await session.connect();
    } catch (cause) {
      await session.close();
      sessions.delete(session.id);
      throw cause;
    }
    options.log(`session ${session.id} opened for principal "${token.principal}" from ${remote}`);
    begin(session);
    try {
      await forward(request, response, session);
    } catch (cause) {
      end(session);
      await closeById(session.id, 'failed initialize');
      throw cause;
    }
    end(session);
    if (!session.initialized) await closeById(session.id, 'initialize failed');
  }

  async function forward(request: IncomingMessage, response: ServerResponse, session: HttpSession): Promise<void> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    response.once('close', abort);
    try {
      const web = toWebRequest(request, controller.signal);
      const answer = await session.transport.handleRequest(web);
      await writeResponse(response, answer);
    } finally {
      response.off('close', abort);
    }
  }

  async function close(): Promise<void> {
    if (closing) {
      await closed;
      return;
    }
    closing = true;
    for (const id of sessions.keys()) await closeById(id, 'server shutdown');
    // A DELETE that landed while the loop ran may still be stopping its child.
    while (closingSessions.size > 0) await Promise.all(closingSessions);
    // Jobs outlive any one session, so they are stopped with the gateway.
    await jobs?.close();
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
    resolveClosed();
  }

  options.signal?.addEventListener('abort', () => {
    void close();
  }, { once: true });

  return { url, port, closed, close };
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // An address the server cannot bind is a configuration failure (exit 2),
    // not an uncaught error, so a script can tell a bad flag from a bad run.
    const fail = (cause: Error): void => {
      reject(new ConfigurationError('INVALID_ARGUMENT', `cannot listen on ${host}:${port}: ${errorMessage(cause)}`));
    };
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      resolve();
    });
  });
}

function toWebRequest(request: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? (Readable.toWeb(request) as ReadableStream<Uint8Array>) : undefined;
  const init = { method: request.method, headers, body, signal, duplex: 'half' } as RequestInit & { duplex: 'half' };
  return new Request(`http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`, init);
}

async function writeResponse(response: ServerResponse, answer: Response): Promise<void> {
  response.statusCode = answer.status;
  answer.headers.forEach((value, name) => {
    response.setHeader(name, value);
  });
  if (answer.body === null) {
    response.end();
    return;
  }
  const reader = answer.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (response.destroyed) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (!response.write(Buffer.from(value))) await drained(response);
    }
  } finally {
    response.end();
  }
}

/** Resolves when a backpressured response can take more, or when it is gone. */
function drained(response: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      response.off('error', fail);
      resolve();
    };
    const fail = (error: Error): void => {
      response.off('drain', done);
      response.off('close', done);
      response.off('error', fail);
      reject(error);
    };
    response.once('drain', done);
    response.once('close', done);
    response.once('error', fail);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The target an `open_session` result names, from its structured content. */
function openedTarget(value: unknown): { target: string; appUrl?: string | undefined } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['target'] !== 'string' || record['target'] === '') return undefined;
  return {
    target: record['target'],
    ...(typeof record['appUrl'] === 'string' && record['appUrl'] !== '' ? { appUrl: record['appUrl'] } : {}),
  };
}

/** The quota key: the app URL's host, or the target name for a target without a URL. */
function domainOf(opened: { target: string; appUrl?: string | undefined }): string {
  if (opened.appUrl !== undefined) {
    try {
      return new URL(opened.appUrl).host;
    } catch {
      // A malformed URL falls back to the target name.
    }
  }
  return opened.target;
}
