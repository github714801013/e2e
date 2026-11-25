/**
 * One MCP session of the HTTP gateway. The gateway's MCP server is a thin
 * proxy: it forwards the four native tools and the guide resources to a
 * private `e2e mcp` child, spawned lazily on the session's first tool or
 * resource call and reused until the session closes. A client that sends
 * several requests therefore keeps one browser and one stdio server, exactly
 * as it would over stdio. The script and job tools are served by the
 * gateway itself, because both outlive a single stdio child.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server, type Tool, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { ConfigurationError, errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { processSecrets } from '@e2e-dev/core/lib/run/secrecy';
import { MCP_INSTRUCTIONS } from '../server.ts';
import { errorResult } from '../tools.ts';
import {
  childEnvironment,
  isJobMcpTool,
  isNativeMcpTool,
  isScriptMcpTool,
  type HttpMcpOptions,
  type HttpMcpToken,
  type HttpMcpTool,
  type NativeMcpTool,
} from './config.ts';
import type { AccountStore } from './accounts.ts';
import { JOB_TOOL_DEFINITIONS, callJobTool } from './job-tools.ts';
import type { JobService } from './jobs.ts';
import { SCRIPT_TOOL_DEFINITIONS, type ScriptService } from './scripts.ts';

/** What the gateway does when a session reaches a lifecycle edge. */
export interface SessionHooks {
  /** `initialize` completed and the session id is now valid. */
  onInitialized(id: string): void;
  /** The client sent `DELETE /mcp/e2e` for this session. */
  onDeleted(id: string): void;
  /** The stdio child exited on its own. */
  onChildGone(id: string): void;
  /** The child answered a native tool; the gateway tracks the target the session holds. */
  onNativeResult(id: string, name: NativeMcpTool, result: { readonly isError?: boolean | undefined; readonly structuredContent?: unknown }): void;
}

interface ChildLink {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

/** The gateway URL the request being handled arrived through. */
const requestBase = new AsyncLocalStorage<string>();

/** Runs one HTTP request with its gateway URL, so a tool result can name it. */
export function withRequestBaseUrl<T>(baseUrl: string, run: () => T): T {
  return requestBase.run(baseUrl, run);
}

/**
 * No deadline from the proxy: a cold mobile session or a screenshot can run
 * past the client's 60-second default. Node clamps a longer timer to 1ms, so
 * this is the longest delay it accepts.
 */
const PROXY_TIMEOUT_MS = 2_147_483_647;

/**
 * One authenticated MCP session, bound to the principal that opened it. A
 * client re-initializing with an id the gateway no longer knows gets a
 * session under that same id, so the handle it holds keeps working.
 */
export class HttpSession {
  readonly id: string;
  readonly allowedTools: ReadonlySet<HttpMcpTool>;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: Server;
  initialized = false;
  timer: NodeJS.Timeout | undefined;
  /** Requests and open streams; the idle timer only runs while this is zero. */
  inFlight = 0;
  closing = false;
  /** A token that grants only script tools never starts the native server. */
  private readonly usesChild: boolean;
  private child: ChildLink | undefined;
  private childPromise: Promise<ChildLink> | undefined;

  constructor(
    private readonly options: HttpMcpOptions,
    readonly token: HttpMcpToken,
    private readonly scripts: ScriptService,
    private readonly jobs: JobService | undefined,
    private readonly accounts: AccountStore | undefined,
    private readonly hooks: SessionHooks,
    id: string = randomUUID(),
  ) {
    this.id = id;
    this.allowedTools = new Set(this.token.tools);
    this.usesChild = this.token.tools.some(isNativeMcpTool);
    this.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => this.id,
      onsessioninitialized: () => {
        this.initialized = true;
        this.hooks.onInitialized(this.id);
      },
      onsessionclosed: () => this.hooks.onDeleted(this.id),
      maxRequestBodySize: options.maxBodyBytes,
    });
    this.server = this.createProxy();
  }

  /** Attaches the proxy server to its transport; call once, before the first request. */
  async connect(): Promise<void> {
    await this.server.connect(this.transport);
  }

  /** The session's stdio child, spawned on first use and reused afterwards. */
  async childLink(): Promise<ChildLink> {
    if (this.child !== undefined) return this.child;
    this.childPromise ??= this.spawnChild().then(
      (link) => {
        this.child = link;
        this.childPromise = undefined;
        return link;
      },
      (cause: unknown) => {
        this.childPromise = undefined;
        throw cause;
      },
    );
    return this.childPromise;
  }

  /** Closes the proxy server and the child; safe to call more than once. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.server.close().catch(() => undefined);
    const child = this.child;
    this.child = undefined;
    if (child !== undefined) {
      await child.client.close().catch(() => undefined);
      return;
    }
    // A child still starting has no client yet; close it when it arrives
    // rather than blocking teardown on a slow or broken stdio handshake.
    const pending = this.childPromise;
    this.childPromise = undefined;
    if (pending !== undefined) void pending.then((link) => link.client.close().catch(() => undefined)).catch(() => undefined);
  }

  private createProxy(): Server {
    const server = new Server(
      { name: 'e2e', version: this.options.version },
      { capabilities: { tools: {}, resources: {} }, instructions: MCP_INSTRUCTIONS },
    );
    server.setRequestHandler('tools/list', async () => {
      const tools: Tool[] = [];
      if (this.usesChild) {
        const { tools: native } = await (await this.childLink()).client.listTools();
        tools.push(
          ...native
            .filter((tool) => isNativeMcpTool(tool.name) && this.allowedTools.has(tool.name))
            .map((tool) => (tool.name === 'open_session' ? withAccountDescription(tool) : tool)),
        );
      }
      tools.push(...SCRIPT_TOOL_DEFINITIONS.filter((tool) => this.allowedTools.has(tool.name as HttpMcpTool)));
      tools.push(...JOB_TOOL_DEFINITIONS.filter((tool) => this.allowedTools.has(tool.name as HttpMcpTool)));
      return { tools };
    });
    server.setRequestHandler('tools/call', async (request, context) => {
      const name = request.params.name;
      if (isScriptMcpTool(name)) {
        if (!this.allowedTools.has(name)) return errorResult(denied(name));
        try {
          return await this.scripts.call(name, request.params.arguments ?? {}, context.mcpReq.signal);
        } catch (cause) {
          return errorResult(cause);
        }
      }
      if (isJobMcpTool(name)) {
        if (!this.allowedTools.has(name)) return errorResult(denied(name));
        if (this.jobs === undefined) {
          return errorResult(new ConfigurationError('INVALID_ARGUMENT', 'job tools are not configured on this gateway'));
        }
        try {
          // A submitted job keeps running when the request is cancelled: that
          // is what lets a client disconnect and poll by job id afterwards.
          return await callJobTool(
            this.jobs,
            this.token,
            name,
            request.params.arguments ?? {},
            requestBase.getStore() ?? '',
          );
        } catch (cause) {
          return errorResult(cause);
        }
      }
      if (!isNativeMcpTool(name) || !this.allowedTools.has(name)) return errorResult(denied(name));
      try {
        const child = await this.childLink();
        // The pool lives in the gateway: the child is handed only the resolved
        // target name, never the account description or its record.
        const params = name === 'open_session' ? await this.rewriteOpenSession(request.params) : request.params;
        const result = await child.client.callTool(params, { signal: context.mcpReq.signal, timeout: PROXY_TIMEOUT_MS });
        this.hooks.onNativeResult(this.id, name, result);
        return result;
      } catch (cause) {
        return errorResult(cause);
      }
    });
    // The guide resources live in the native server, so a script-only token
    // has none to read and must not start it.
    server.setRequestHandler('resources/list', async () => (this.usesChild ? (await this.childLink()).client.listResources() : { resources: [] }));
    server.setRequestHandler('resources/templates/list', async () =>
      this.usesChild ? (await this.childLink()).client.listResourceTemplates() : { resourceTemplates: [] },
    );
    server.setRequestHandler('resources/read', async (request, context) => {
      if (!this.usesChild) throw new ConfigurationError('POLICY_DENIED', `resource "${request.params.uri}" is not permitted for this client`);
      const child = await this.childLink();
      return child.client.readResource(request.params, { signal: context.mcpReq.signal, timeout: PROXY_TIMEOUT_MS });
    });
    return server;
  }

  /**
   * Replaces `accountDescription` with the one target it selects. The child
   * sees a plain `open_session { target }`, exactly as if the caller had named
   * the target; a description and a target at once cannot both be honored.
   */
  private async rewriteOpenSession(params: ToolCallParams): Promise<ToolCallParams> {
    const args = params.arguments;
    if (args === undefined || args['accountDescription'] === undefined) return params;
    if (this.accounts === undefined) {
      throw new ConfigurationError('INVALID_ARGUMENT', 'accountDescription needs an account pool on this gateway');
    }
    // Naming both is the conflict, whatever the description holds: an empty
    // description beside a target is still two selectors.
    if (args['target'] !== undefined) {
      throw new ConfigurationError('ACCOUNT_SELECTION_CONFLICT', 'open_session takes target or accountDescription, not both');
    }
    const description = args['accountDescription'];
    if (typeof description !== 'string' || description.trim() === '') {
      throw new ConfigurationError('ACCOUNT_INVALID', 'open_session needs accountDescription as a non-empty string when given');
    }
    const account = await this.accounts.resolve(description);
    const rewritten: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (key !== 'accountDescription') rewritten[key] = value;
    }
    rewritten['target'] = account.name;
    return { ...params, arguments: rewritten };
  }

  private async spawnChild(): Promise<ChildLink> {
    const accountEnv = this.accounts === undefined ? {} : await this.accounts.childEnvironment();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: childArgs(this.options),
      cwd: this.options.cwd,
      env: { ...childEnvironment(this.options.env), ...accountEnv },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e-http-gateway', version: this.options.version });
    // The SDK exposes plain callback properties, not event targets.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onerror = (error) => {
      this.options.log(`[session ${this.id}] child error: ${processSecrets.redact(errorMessage(error))}`);
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    client.onclose = () => {
      if (this.closing) return;
      this.options.log(`[session ${this.id}] child exited`);
      this.hooks.onChildGone(this.id);
    };
    transport.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text !== '') this.options.log(`[session ${this.id}] ${processSecrets.redact(text)}`);
    });
    await client.connect(transport);
    this.options.log(`[session ${this.id}] child ready (pid ${String(transport.pid)})`);
    return { client, transport };
  }
}

function denied(name: string): ConfigurationError {
  return new ConfigurationError('POLICY_DENIED', `tool "${name}" is not permitted for this client`);
}

type ToolCallParams = Parameters<Client['callTool']>[0];

/** The native `open_session` schema, with the gateway's account selector added. */
function withAccountDescription(tool: Tool): Tool {
  const schema = tool.inputSchema;
  if (typeof schema !== 'object' || schema === null) return tool;
  const existing = typeof schema.properties === 'object' && schema.properties !== null ? schema.properties : {};
  const inputSchema: unknown = {
    ...schema,
    properties: {
      ...existing,
      accountDescription: {
        type: 'string',
        maxLength: 200,
        description: 'Words selecting one enabled account pool account; cannot be combined with target.',
      },
    },
  };
  return {
    ...tool,
    description: `${tool.description ?? ''} accountDescription selects one enabled account pool account by words from its description, instead of target.`.trim(),
    inputSchema: inputSchema as Tool['inputSchema'],
  };
}

function childArgs(options: HttpMcpOptions): string[] {
  // One native session per child: the gateway owns the client count, and a
  // child serves exactly one HTTP client.
  const args = [options.cliEntry, 'mcp', '--max-sessions', '1'];
  if (options.configPath !== undefined) args.push('--config', options.configPath);
  if (options.target !== undefined) args.push('--target', options.target);
  if (options.headed) args.push('--headed');
  return args;
}
