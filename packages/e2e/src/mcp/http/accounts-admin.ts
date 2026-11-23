/**
 * The account pool's admin API and its page. Both are gated by
 * `E2E_HTTP_MCP_ADMIN_TOKEN`, a credential separate from every MCP token: a
 * token that may run tests cannot add or remove the accounts those tests log
 * in with. Responses never carry a password, and request bodies are bounded
 * before they are parsed. The page is a static shell: it holds no account
 * data, and every field it shows is set with `textContent` or an input value.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigurationError, InfrastructureError, isE2EError } from '../../internal/errors.ts';
import type { AccountStore } from './accounts.ts';
import { bearerToken } from './config.ts';

/** The most a JSON admin request body may hold. */
const MAX_BODY_BYTES = 64 * 1024;
const ADMIN_PAGE = '/admin';
const ACCOUNTS_API = '/admin/api/accounts';

export interface AdminRouteOptions {
  /** Undefined turns every admin route off; the paths answer as any unknown route. */
  readonly token: string | undefined;
  readonly accounts: AccountStore;
  readonly log: (line: string) => void;
}

/**
 * Serves one admin request, and returns whether it owned the path. A route
 * that belongs to the admin API answers even when the credential is wrong, so
 * a probe cannot tell a missing pool from a protected one.
 */
export async function handleAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  options: AdminRouteOptions,
): Promise<boolean> {
  if (pathname === ADMIN_PAGE) {
    if (options.token === undefined) return false;
    servePage(request, response);
    return true;
  }
  if (pathname !== ACCOUNTS_API && !pathname.startsWith(`${ACCOUNTS_API}/`)) return false;
  if (options.token === undefined) return false;
  adminHeaders(response);
  if (!authorized(request.headers.authorization, options.token)) {
    options.log(`admin request refused: bad or missing admin token`);
    const refusal = new ConfigurationError('ADMIN_UNAUTHORIZED', 'a valid admin token is required');
    send(response, 401, { error: { code: refusal.code, message: refusal.message } });
    return true;
  }
  try {
    if (pathname === ACCOUNTS_API) {
      await serveCollection(request, response, options.accounts);
      return true;
    }
    const name = decodeSegment(pathname.slice(ACCOUNTS_API.length + 1));
    if (name === undefined || name.includes('/')) {
      send(response, 404, { error: { code: 'ACCOUNT_NOT_FOUND', message: 'the admin route does not exist' } });
      return true;
    }
    await serveAccount(request, response, options.accounts, name);
    return true;
  } catch (cause) {
    const failure = isE2EError(cause)
      ? cause
      : new InfrastructureError('INTERNAL_ERROR', cause instanceof Error ? cause.message : String(cause));
    send(response, statusFor(failure.code), { error: { code: failure.code, message: failure.message } });
    return true;
  }
}

function servePage(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET') {
    methodNotAllowed(response, 'GET');
    return;
  }
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  );
  adminHeaders(response);
  response.end(ADMIN_PAGE_HTML);
}

async function serveCollection(request: IncomingMessage, response: ServerResponse, accounts: AccountStore): Promise<void> {
  if (request.method === 'GET') {
    send(response, 200, { accounts: (await accounts.list()).map(publicView) });
    return;
  }
  if (request.method !== 'POST') {
    methodNotAllowed(response, 'GET, POST');
    return;
  }
  const body = await readJsonObject(request, 'POST');
  rejectUnknown(body, ['name', 'description', 'url', 'username', 'password'], 'POST');
  const account = await accounts.create({
    name: body['name'] as string,
    description: body['description'] as string,
    url: body['url'] as string,
    username: body['username'] as string,
    password: body['password'] as string,
  });
  send(response, 201, { account });
}

async function serveAccount(
  request: IncomingMessage,
  response: ServerResponse,
  accounts: AccountStore,
  name: string,
): Promise<void> {
  if (request.method === 'PATCH') {
    const body = await readJsonObject(request, 'PATCH');
    rejectUnknown(body, ['description', 'enabled', 'password'], 'PATCH');
    const account = await accounts.update(name, {
      ...(body['description'] === undefined ? {} : { description: body['description'] as string }),
      ...(body['enabled'] === undefined ? {} : { enabled: body['enabled'] as boolean }),
      ...(body['password'] === undefined ? {} : { password: body['password'] as string }),
    });
    send(response, 200, { account });
    return;
  }
  if (request.method === 'DELETE') {
    await accounts.remove(name);
    response.statusCode = 204;
    response.end();
    return;
  }
  methodNotAllowed(response, 'PATCH, DELETE');
}

/** A 405 that names the methods the route takes, through the error taxonomy. */
function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader('allow', allow);
  const refusal = new ConfigurationError('METHOD_NOT_ALLOWED', `use ${allow}`);
  send(response, 405, { error: { code: refusal.code, message: refusal.message } });
}

function publicView(record: { name: string; description: string; url: string; username: string; enabled: boolean; createdAt: string; updatedAt: string }): unknown {
  return {
    name: record.name,
    description: record.description,
    url: record.url,
    username: record.username,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Constant-time comparison of SHA-256 digests, so token length leaks nothing. */
function authorized(header: string | undefined, token: string): boolean {
  const presented = bearerToken(header);
  if (presented === undefined) return false;
  return timingSafeEqual(createHash('sha256').update(presented, 'utf8').digest(), digest(token));
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

async function readJsonObject(request: IncomingMessage, method: string): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw invalid(`a ${method} body is limited to ${String(MAX_BODY_BYTES)} bytes`);
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // The parser's message can quote the body, which holds a password here.
    throw invalid(`the ${method} body is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid(`the ${method} body must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function rejectUnknown(body: Record<string, unknown>, allowed: readonly string[], method: string): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalid(`${method} does not take ${JSON.stringify(key)}; use ${allowed.join(', ')}`);
  }
}

/** Admin answers are never cached, never leak a referrer, and are never sniffed. */
function adminHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function statusFor(code: string): number {
  switch (code) {
    case 'ACCOUNT_NOT_FOUND':
      return 404;
    case 'ACCOUNT_DUPLICATE':
    case 'ACCOUNT_INVALID':
      return 400;
    case 'ACCOUNT_STORE_INVALID':
      return 500;
    default:
      return 500;
  }
}

function decodeSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === '' ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function invalid(message: string): ConfigurationError {
  return new ConfigurationError('ACCOUNT_INVALID', message);
}

/** The page shell; account data is fetched with the token held in sessionStorage. */
const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>e2e 账号池管理</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px auto; max-width: 1180px; padding: 0 16px; color: #1f2328; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin: 16px 0 8px; }
  label { display: inline-flex; flex-direction: column; gap: 4px; margin: 0 12px 12px 0; }
  input { padding: 4px 6px; font: inherit; }
  button { font: inherit; padding: 3px 10px; margin-right: 6px; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border-bottom: 1px solid #d0d7de; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  td input { width: 100%; box-sizing: border-box; }
  td input[type=password] { width: 120px; }
  .notice { padding: 8px 12px; border-radius: 6px; background: #fff8c5; border: 1px solid #d4a72c; }
  .error { color: #cf222e; margin: 4px 0 0; }
  .muted { color: #59636e; }
  .wide { width: 260px; }
</style>
</head>
<body>
<h1>e2e 账号池管理</h1>
<p id="notice" class="notice" hidden></p>
<p id="missing" class="muted" hidden>地址中没有管理令牌。请使用带 <code>?token=…</code> 的地址打开本页。</p>

<form id="create" hidden>
  <h2>新增账号</h2>
  <label>名称（小写字母、数字、连字符）<input name="name" required maxlength="64" pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"></label>
  <label>描述<input name="description" required maxlength="200" class="wide"></label>
  <label>URL<input name="url" required type="url" placeholder="https://"></label>
  <label>用户名<input name="username" required autocomplete="off"></label>
  <label>密码<input name="password" required type="password" autocomplete="new-password"></label>
  <button type="submit">新增</button>
  <p id="create-error" class="error" hidden></p>
</form>

<p id="empty" class="muted" hidden>账号池为空。</p>
<table id="table" hidden>
  <thead><tr><th>名称</th><th>描述</th><th>URL</th><th>用户名</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
  <tbody id="rows"></tbody>
</table>

<script>
(function () {
  'use strict';
  var KEY = 'e2e-admin-token';
  var params = new URLSearchParams(location.search);
  var fromUrl = params.get('token');
  if (fromUrl !== null && fromUrl !== '') {
    sessionStorage.setItem(KEY, fromUrl);
    history.replaceState(null, '', location.pathname);
  }
  var token = sessionStorage.getItem(KEY);
  var notice = document.getElementById('notice');
  var missing = document.getElementById('missing');
  var form = document.getElementById('create');
  var createError = document.getElementById('create-error');
  var rows = document.getElementById('rows');
  var table = document.getElementById('table');
  var empty = document.getElementById('empty');
  if (token === null || token === '') { missing.hidden = false; return; }
  form.hidden = false;

  function showError(message) { notice.textContent = message; notice.hidden = false; }
  function clearNotice() { notice.hidden = true; notice.textContent = ''; }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body === undefined
        ? { authorization: 'Bearer ' + token }
        : { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = text === '' ? undefined : JSON.parse(text);
        if (!response.ok) {
          if (response.status === 401) {
            sessionStorage.removeItem(KEY);
            // The load() catch below shows the thrown message, so it carries
            // the same guidance instead of the server's English text.
            throw new Error('管理令牌无效，请用带 token 的地址重新打开');
          }
          throw new Error(data && data.error ? data.error.message : 'HTTP ' + response.status);
        }
        return data;
      });
    });
  }

  function element(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function action(label, onClick) {
    var button = element('button', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function render(accounts) {
    rows.textContent = '';
    table.hidden = accounts.length === 0;
    empty.hidden = accounts.length !== 0;
    accounts.forEach(function (account) {
      var row = element('tr');
      row.appendChild(element('td', account.name));
      var descriptionCell = element('td');
      var description = element('input');
      description.value = account.description;
      description.maxLength = 200;
      descriptionCell.appendChild(description);
      row.appendChild(descriptionCell);
      row.appendChild(element('td', account.url));
      row.appendChild(element('td', account.username));
      row.appendChild(element('td', account.enabled ? '启用' : '禁用'));
      row.appendChild(element('td', account.updatedAt));
      var actions = element('td');
      actions.appendChild(action('保存描述', function () {
        api('PATCH', '/admin/api/accounts/' + encodeURIComponent(account.name), { description: description.value })
          .then(load).catch(function (error) { showError(error.message); });
      }));
      actions.appendChild(action(account.enabled ? '禁用' : '启用', function () {
        api('PATCH', '/admin/api/accounts/' + encodeURIComponent(account.name), { enabled: !account.enabled })
          .then(load).catch(function (error) { showError(error.message); });
      }));
      var password = element('input');
      password.type = 'password';
      password.autocomplete = 'new-password';
      password.placeholder = '新密码';
      actions.appendChild(password);
      actions.appendChild(action('改密', function () {
        if (password.value === '') { showError('新密码不能为空'); return; }
        api('PATCH', '/admin/api/accounts/' + encodeURIComponent(account.name), { password: password.value })
          .then(function () { password.value = ''; clearNotice(); load(); })
          .catch(function (error) { showError(error.message); });
      }));
      actions.appendChild(action('删除', function () {
        if (!confirm('删除账号 ' + account.name + '？')) return;
        api('DELETE', '/admin/api/accounts/' + encodeURIComponent(account.name))
          .then(load).catch(function (error) { showError(error.message); });
      }));
      row.appendChild(actions);
      rows.appendChild(row);
    });
  }

  function load() {
    return api('GET', '/admin/api/accounts')
      .then(function (data) { clearNotice(); render(data.accounts); })
      .catch(function (error) { rows.textContent = ''; table.hidden = true; showError(error.message); });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    createError.hidden = true;
    var data = new FormData(form);
    api('POST', '/admin/api/accounts', {
      name: data.get('name'),
      description: data.get('description'),
      url: data.get('url'),
      username: data.get('username'),
      password: data.get('password')
    }).then(function () {
      form.reset();
      load();
    }).catch(function (error) {
      createError.textContent = error.message;
      createError.hidden = false;
    });
  });

  load();
})();
</script>
</body>
</html>
`;
