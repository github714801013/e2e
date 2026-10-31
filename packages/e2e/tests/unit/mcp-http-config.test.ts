import { describe, expect, it } from 'vitest';
import {
  authenticate,
  bearerToken,
  childEnvironment,
  clientAddress,
  defaultHosts,
  defaultOrigins,
  hostAllowed,
  httpPath,
  loadHttpMcpTokens,
  normalizeAddress,
  normalizeHost,
  originAllowed,
} from '../../src/mcp/http/config.ts';

const TOKEN = 'unit-test-token-0123456789abcdef';

describe('HTTP MCP token configuration', () => {
  it('requires a non-empty JSON array of strong tokens', () => {
    expect(() => loadHttpMcpTokens({})).toThrow(/E2E_HTTP_MCP_TOKENS/);
    expect(() => loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: '  ' })).toThrow(/needs E2E_HTTP_MCP_TOKENS/);
    expect(() => loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: 'not json' })).toThrow(/not valid JSON/);
    expect(() => loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: '[]' })).toThrow(/non-empty/);
    expect(() => loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: 'short' }]) })).toThrow(/at least 32/);
    expect(() => loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: `${TOKEN} with space` }]) })).toThrow(/no whitespace/);
    expect(() => loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: TOKEN, tools: ['teleport'] }]) })).toThrow(/open_session/);
    expect(() => loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: TOKEN }, { token: TOKEN }]) })).toThrow(/used twice/);
    // A misspelled field would otherwise fall back to the wider default set.
    expect(() => loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: TOKEN, tool: ['open_session'] }]) })).toThrow(/unknown field "tool"/);
  });

  it('defaults the principal, the four native tools, and the two script reads', () => {
    const [token] = loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: TOKEN }]) });
    expect(token?.principal).toBe('default');
    expect(token?.tools).toEqual(['open_session', 'tools', 'call', 'close_session', 'list_test_scripts', 'get_test_script']);
  });

  it('grants save_test_script only when a token names it', () => {
    const [token] = loadHttpMcpTokens({
      E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: TOKEN, tools: ['list_test_scripts', 'get_test_script', 'save_test_script'] }]),
    });
    expect(token?.tools).toEqual(['list_test_scripts', 'get_test_script', 'save_test_script']);
  });

  it('grants the job tools only when a token names them, with a principal', () => {
    const [granted] = loadHttpMcpTokens({
      E2E_HTTP_MCP_TOKENS: JSON.stringify([
        { token: TOKEN, principal: 'alpha', tools: ['run_test', 'get_test_status', 'get_test_report'] },
      ]),
    });
    expect(granted?.tools).toEqual(['run_test', 'get_test_status', 'get_test_report']);
    // Jobs are private to their principal, so a shared default is refused.
    expect(() =>
      loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: TOKEN, tools: ['run_test'] }]) }),
    ).toThrow(/principal is required/);
  });

  it('keeps an explicit principal and tool subset, without duplicates', () => {
    const [token] = loadHttpMcpTokens({
      E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: TOKEN, principal: ' alpha ', tools: ['open_session', 'call', 'open_session'] }]),
    });
    expect(token?.principal).toBe('alpha');
    expect(token?.tools).toEqual(['open_session', 'call']);
  });

  it('authenticates only an exact Bearer token', () => {
    const tokens = loadHttpMcpTokens({ E2E_HTTP_MCP_TOKENS: JSON.stringify([{ token: TOKEN, principal: 'alpha' }]) });
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`Basic ${TOKEN}`)).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(authenticate(`Bearer ${TOKEN}`, tokens)?.principal).toBe('alpha');
    expect(authenticate(`Bearer ${TOKEN}x`, tokens)).toBeUndefined();
    expect(authenticate(`Bearer ${'x'.repeat(32)}`, tokens)).toBeUndefined();
    expect(authenticate(undefined, tokens)).toBeUndefined();
  });
});

describe('HTTP MCP endpoint path', () => {
  it('normalizes a trailing slash and refuses the health check route', () => {
    expect(httpPath(undefined)).toBe('/mcp/e2e');
    expect(httpPath('/gateway/')).toBe('/gateway');
    expect(() => httpPath('/healthz')).toThrow(/health check/);
    expect(() => httpPath('/healthz/')).toThrow(/health check/);
    expect(() => httpPath('relative')).toThrow(/absolute/);
    expect(() => httpPath('/')).toThrow(/absolute/);
    expect(() => httpPath('/mcp?x')).toThrow(/absolute/);
  });
});

describe('HTTP MCP host and origin policy', () => {
  it('accepts only the configured Host values, port included', () => {
    const allowed = defaultHosts(3001);
    expect(allowed).toEqual(['127.0.0.1:3001', 'localhost:3001', '[::1]:3001']);
    expect(hostAllowed('127.0.0.1:3001', allowed)).toBe(true);
    expect(hostAllowed('LOCALHOST:3001', allowed)).toBe(true);
    expect(hostAllowed('localhost:3001.', allowed)).toBe(true);
    expect(hostAllowed('localhost:3002', allowed)).toBe(false);
    expect(hostAllowed('evil.example:3001', allowed)).toBe(false);
    expect(hostAllowed(undefined, allowed)).toBe(false);
    expect(normalizeHost(' Example.COM.:8080 ')).toBe('example.com:8080');
  });

  it('lets an absent Origin through and refuses null, malformed, and unlisted ones', () => {
    const allowed = defaultOrigins(3001);
    expect(originAllowed(undefined, allowed)).toBe(true);
    expect(originAllowed('http://127.0.0.1:3001', allowed)).toBe(true);
    expect(originAllowed('HTTP://LOCALHOST:3001', allowed)).toBe(true);
    expect(originAllowed('http://localhost:3002', allowed)).toBe(false);
    expect(originAllowed('https://localhost:3001', allowed)).toBe(false);
    expect(originAllowed('null', allowed)).toBe(false);
    expect(originAllowed('not a url', allowed)).toBe(false);
    expect(originAllowed('http://evil.example', allowed)).toBe(false);
  });

  it('believes X-Forwarded-For only from a configured trusted proxy', () => {
    expect(clientAddress('127.0.0.1', '203.0.113.9', [])).toBe('127.0.0.1');
    expect(clientAddress('127.0.0.1', '203.0.113.9', ['127.0.0.1'])).toBe('203.0.113.9');
    expect(clientAddress('::ffff:127.0.0.1', '203.0.113.9', ['127.0.0.1'])).toBe('203.0.113.9');
    expect(clientAddress('::ffff:127.0.0.1', '', ['127.0.0.1'])).toBe('127.0.0.1');
    // The client's own leading hop is not believed, nor is anything that
    // cannot be an address.
    expect(clientAddress('127.0.0.1', '198.51.100.7, 203.0.113.9, 127.0.0.1', ['127.0.0.1'])).toBe('203.0.113.9');
    expect(clientAddress('127.0.0.1', '203.0.113.9\nforged, 127.0.0.1', ['127.0.0.1'])).toBe('127.0.0.1');
    expect(clientAddress(undefined, '203.0.113.9', ['127.0.0.1'])).toBe('unknown');
    expect(normalizeAddress('::ffff:10.0.0.2')).toBe('10.0.0.2');
    expect(normalizeAddress('10.0.0.2')).toBe('10.0.0.2');
  });
});

describe('HTTP MCP child environment', () => {
  it('removes every spelling of the token variable and drops undefined values', () => {
    const env = childEnvironment({
      PATH: '/bin',
      E2E_HTTP_MCP_TOKENS: 'secret',
      e2e_http_mcp_tokens: 'secret',
      E2e_Http_Mcp_Tokens: 'secret',
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: '/bin' });
  });
});
