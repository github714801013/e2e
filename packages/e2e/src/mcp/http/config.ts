/**
 * Configuration and authorization for `e2e mcp --http`. The gateway is a
 * separate trust boundary from the stdio server: it listens on a socket, so
 * every request is authenticated before it can open a session, and Host and
 * Origin are checked before the token is even read.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { ConfigurationError } from '../../internal/errors.ts';

/** The tools the native stdio server registers and the gateway proxies. */
const NATIVE_MCP_TOOLS = ['open_session', 'tools', 'call', 'close_session'] as const;
export type NativeMcpTool = (typeof NATIVE_MCP_TOOLS)[number];

/** The script tools the gateway serves itself. */
const SCRIPT_MCP_TOOLS = ['list_test_scripts', 'get_test_script', 'save_test_script'] as const;
export type ScriptMcpTool = (typeof SCRIPT_MCP_TOOLS)[number];

/** The asynchronous job tools the gateway serves itself. */
const JOB_MCP_TOOLS = ['run_test', 'get_test_status', 'get_test_report', 'list_test_artifacts'] as const;
export type JobMcpTool = (typeof JOB_MCP_TOOLS)[number];

/** Every tool a token may name. */
export type HttpMcpTool = NativeMcpTool | ScriptMcpTool | JobMcpTool;

/** Reading scripts is open to every token; saving one and running jobs are explicit grants. */
const DEFAULT_MCP_TOOLS: readonly HttpMcpTool[] = [...NATIVE_MCP_TOOLS, 'list_test_scripts', 'get_test_script'];
const ALL_MCP_TOOLS: readonly HttpMcpTool[] = [...NATIVE_MCP_TOOLS, ...SCRIPT_MCP_TOOLS, ...JOB_MCP_TOOLS];

/** Whether a name belongs to the native child, whose tools are proxied. */
export function isNativeMcpTool(name: string): name is NativeMcpTool {
  return (NATIVE_MCP_TOOLS as readonly string[]).includes(name);
}

/** Whether a name belongs to the gateway's own script tools. */
export function isScriptMcpTool(name: string): name is ScriptMcpTool {
  return (SCRIPT_MCP_TOOLS as readonly string[]).includes(name);
}

/** Whether a name belongs to the gateway's own job tools. */
export function isJobMcpTool(name: string): name is JobMcpTool {
  return (JOB_MCP_TOOLS as readonly string[]).includes(name);
}

/** Sessions one principal may hold on one target domain unless `--max-sessions-per-domain` says otherwise. */
export const SESSION_PER_DOMAIN_BOUNDS = { min: 1, max: 100, default: 20 } as const;

/** Workers one dynamic run may start unless `--max-workers` says otherwise. */
export const DEFAULT_MAX_WORKERS = 4;
/** Test runs the gateway keeps alive at once unless `--max-runs` says otherwise. */
export const DEFAULT_MAX_RUNS = 2;
/** The most unfinished jobs one run may hold; the next submission is refused. */
export const MAX_QUEUED_JOBS_PER_RUN = 20;
/** How long one run may stay alive, across every job it serves. */
export const RUN_TIMEOUT_MS = 30 * 60_000;
/** How long a finished job stays readable before its record is removed. */
export const JOB_RETENTION_MS = 14 * 24 * 60 * 60_000;

/** One Bearer credential and what its principal may call. */
export interface HttpMcpToken {
  readonly principal: string;
  readonly tools: readonly HttpMcpTool[];
  /** SHA-256 of the token, so comparison is constant-time. */
  readonly digest: Buffer;
}

/** Everything the gateway needs; the CLI fills this from flags and the environment. */
export interface HttpMcpOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** Explicit `Host` values; undefined means the loopback names for the bound port. */
  readonly allowedHosts?: readonly string[] | undefined;
  /** Explicit `Origin` values; undefined means the loopback origins for the bound port. */
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly trustedProxies: readonly string[];
  /** Sessions one principal may hold on one domain; a new one reclaims the least recently active. */
  readonly maxSessionsPerDomain: number;
  /** Workers one run may start; the project config's `workers` is capped by it. */
  readonly maxWorkers?: number | undefined;
  /** Test runs alive at once; another RunKey is refused past it. */
  readonly maxRuns?: number | undefined;
  /** How long one run may stay alive; a test shortens the default 30 minutes. */
  readonly runTimeoutMs?: number | undefined;
  /** How long one job may run; a test shortens the default 15 minutes. */
  readonly jobTimeoutMs?: number | undefined;
  /** How long one job may wait for authentication; a test shortens the default 2 minutes. */
  readonly authTimeoutMs?: number | undefined;
  /** How long a finished job stays readable; a test shortens the default 14 days. */
  readonly retentionMs?: number | undefined;
  /** How long a Runner child may take to become ready; a test shortens the default 30 seconds. */
  readonly startupTimeoutMs?: number | undefined;
  /** Close an idle MCP session after this long; 0 disables the timeout. */
  readonly sessionIdleMs: number;
  readonly maxBodyBytes: number;
  readonly tokens: readonly HttpMcpToken[];
  /** The directory the script tools resolve every path against. */
  readonly testRoot: string;
  readonly cwd: string;
  readonly configPath?: string | undefined;
  readonly target?: string | undefined;
  readonly headed: boolean;
  readonly version: string;
  readonly env: NodeJS.ProcessEnv;
  /** The built CLI entry, spawned as each session's stdio server. */
  readonly cliEntry: string;
  readonly log: (line: string) => void;
  readonly signal?: AbortSignal | undefined;
}

/** A token must be long enough to be a secret, not a password someone types. */
const MIN_TOKEN_LENGTH = 32;

/**
 * Reads `E2E_HTTP_MCP_TOKENS`: a JSON array of `{ token, principal, tools? }`.
 * A missing or empty variable is refused: an HTTP server with no credential
 * is a server anyone on the host can drive.
 */
export function loadHttpMcpTokens(env: NodeJS.ProcessEnv): HttpMcpToken[] {
  const raw = env['E2E_HTTP_MCP_TOKENS'];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigurationError(
      'INVALID_ARGUMENT',
      'e2e mcp --http needs E2E_HTTP_MCP_TOKENS: a JSON array of { token, principal, tools? }',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser quotes the offending text, which in a misconfiguration can
    // be a raw token; the log gets a fixed message instead.
    throw new ConfigurationError('INVALID_ARGUMENT', 'E2E_HTTP_MCP_TOKENS is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigurationError('INVALID_ARGUMENT', 'E2E_HTTP_MCP_TOKENS must be a non-empty JSON array');
  }
  const seen = new Set<string>();
  return parsed.map((entry: unknown, index): HttpMcpToken => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigurationError('INVALID_ARGUMENT', `E2E_HTTP_MCP_TOKENS[${index}] must be an object`);
    }
    // An unknown key is a typo that would silently fall back to the default
    // set, which is wider than what the operator meant to grant.
    for (const key of Object.keys(entry)) {
      if (key !== 'token' && key !== 'principal' && key !== 'tools') {
        throw new ConfigurationError(
          'INVALID_ARGUMENT',
          `E2E_HTTP_MCP_TOKENS[${index}] has unknown field ${JSON.stringify(key)}; use token, principal, and tools`,
        );
      }
    }
    const { token, principal, tools } = entry as { token?: unknown; principal?: unknown; tools?: unknown };
    // A whitespace token can never match the Bearer grammar, so it would
    // start cleanly and then refuse every request.
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) {
      throw new ConfigurationError(
        'INVALID_ARGUMENT',
        `E2E_HTTP_MCP_TOKENS[${index}].token must be at least ${MIN_TOKEN_LENGTH} characters with no whitespace`,
      );
    }
    if (seen.has(token)) throw new ConfigurationError('INVALID_ARGUMENT', `E2E_HTTP_MCP_TOKENS[${index}].token is used twice`);
    seen.add(token);
    if (principal !== undefined && (typeof principal !== 'string' || principal.trim() === '')) {
      throw new ConfigurationError('INVALID_ARGUMENT', `E2E_HTTP_MCP_TOKENS[${index}].principal must be a non-empty string`);
    }
    const names = tools ?? [...DEFAULT_MCP_TOOLS];
    if (!Array.isArray(names) || names.length === 0 || names.some((name) => !ALL_MCP_TOOLS.includes(name as HttpMcpTool))) {
      throw new ConfigurationError(
        'INVALID_ARGUMENT',
        `E2E_HTTP_MCP_TOKENS[${index}].tools must list one or more of: ${ALL_MCP_TOOLS.join(', ')}`,
      );
    }
    // Jobs are readable by their principal; a shared default would let two
    // clients configured without one read each other's jobs.
    if (principal === undefined && names.some((name) => isJobMcpTool(name as string))) {
      throw new ConfigurationError(
        'INVALID_ARGUMENT',
        `E2E_HTTP_MCP_TOKENS[${index}].principal is required when tools include a job tool`,
      );
    }
    return {
      principal: typeof principal === 'string' ? principal.trim() : 'default',
      tools: [...new Set(names as HttpMcpTool[])],
      digest: digestToken(token),
    };
  });
}

function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** The token in an `Authorization: Bearer …` header, or undefined for any other shape. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** The principal a request authenticates as, or undefined when no token matches. */
export function authenticate(header: string | undefined, tokens: readonly HttpMcpToken[]): HttpMcpToken | undefined {
  const presented = bearerToken(header);
  if (presented === undefined) return undefined;
  const digest = digestToken(presented);
  let match: HttpMcpToken | undefined;
  for (const token of tokens) {
    if (timingSafeEqual(digest, token.digest)) match ??= token;
  }
  return match;
}

/** Lower-cased `Host` value without a trailing dot in its host name. */
export function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.(?=:\d+$|$)/, '');
}

/** Default `Host` values for a loopback listener. */
export function defaultHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

/** Default `Origin` values for a loopback listener. */
export function defaultOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

/** Whether a `Host` header names one of the allowed values; an absent header is refused. */
export function hostAllowed(host: string | undefined, allowed: readonly string[]): boolean {
  if (host === undefined) return false;
  const normalized = normalizeHost(host);
  return allowed.some((value) => normalizeHost(value) === normalized);
}

/**
 * Whether an `Origin` header is allowed. An absent Origin passes: non-browser
 * MCP clients send none. `null`, a malformed value, or any listed origin other
 * than an allowed one fails closed.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  if (normalized === 'null') return false;
  return allowed.some((value) => {
    try {
      return new URL(value).origin === normalized;
    } catch {
      return false;
    }
  });
}

/** The socket peer without IPv6-mapped IPv4 decoration. */
export function normalizeAddress(address: string | undefined): string {
  if (address === undefined) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/**
 * The address to log for a request. A forwarded address is believed only when
 * the socket peer is a configured trusted proxy; otherwise the peer is used.
 */
export function clientAddress(remote: string | undefined, forwarded: string | undefined, trusted: readonly string[]): string {
  const peer = normalizeAddress(remote);
  if (forwarded === undefined || !trusted.includes(peer)) return peer;
  // The left of the header is whatever the client sent; only the hops the
  // trusted proxies appended are believed, so walk from the right past them.
  const hops = forwarded.split(',').map((hop) => normalizeAddress(hop.trim())).filter((hop) => hop !== '');
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = hops[index]!;
    // The value reaches a log line, so only something that can be an address.
    if (!trusted.includes(hop) && /^[0-9a-fA-F:.]+$/.test(hop)) return hop;
  }
  return peer;
}

/** The MCP endpoint path; `/healthz` belongs to the gateway's own health check. */
export function httpPath(value: string | undefined): string {
  const path = value ?? '/mcp/e2e';
  const normalized = path.replace(/\/+$/, '');
  if (!path.startsWith('/') || normalized === '' || normalized.includes('?') || normalized.includes('#')) {
    throw new ConfigurationError('INVALID_ARGUMENT', '--path must be an absolute path such as /mcp/e2e');
  }
  if (normalized === '/healthz') {
    throw new ConfigurationError('INVALID_ARGUMENT', '--path cannot be /healthz: the gateway serves its health check there');
  }
  return normalized;
}

/** A child environment with the gateway's own credentials removed, every spelling on Windows. */
export function childEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0].toUpperCase() !== 'E2E_HTTP_MCP_TOKENS',
    ),
  );
}
