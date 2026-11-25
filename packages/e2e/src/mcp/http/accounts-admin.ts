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
import { ConfigurationError, InfrastructureError, isE2EError } from '@e2e-dev/core/lib/internal/errors';
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
  :root {
    color-scheme: light dark;
    --bg: #f3f5f8;
    --surface: #ffffff;
    --thead: #f4f6f9;
    --row-hover: #f7f9fc;
    --border: #dde3ea;
    --border-strong: #7a8797;
    --text: #1b2430;
    --muted: #5b6877;
    --accent: #1f5fd0;
    --accent-hover: #1749a3;
    --on-accent: #ffffff;
    --danger: #b42318;
    --danger-border: #d9a09a;
    --ok: #14683d;
    --warn-bg: #fff6d9;
    --warn-border: #d9ad2f;
    --radius: 12px;
    --shadow: 0 1px 2px rgb(15 23 42 / 5%), 0 8px 24px rgb(15 23 42 / 6%);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e131a;
      --surface: #161d27;
      --thead: #1b2431;
      --row-hover: #1b2431;
      --border: #283241;
      --border-strong: #5c6d84;
      --text: #e5ebf2;
      --muted: #9aa7b6;
      --accent: #5b9bff;
      --accent-hover: #7fb2ff;
      --on-accent: #0a1020;
      --danger: #ff8178;
      --danger-border: #6b3a37;
      --ok: #4fd07f;
      --warn-bg: #372f18;
      --warn-border: #8f7420;
      --shadow: 0 1px 2px rgb(0 0 0 / 35%), 0 8px 24px rgb(0 0 0 / 30%);
    }
  }
  body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--text); font: 14px/1.55 system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .page { max-width: 1200px; margin-inline: auto; }
  .page-header { margin-block-end: 20px; }
  .page-header h1 { margin: 0 0 4px; font-size: 22px; }
  .page-header p { margin: 0; }
  .muted { color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 18px 20px 20px; margin-block-end: 16px; }
  .card h2 { margin: 0 0 14px; font-size: 15px; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-block-end: 12px; }
  .card-head h2 { margin: 0; }
  .notice { padding: 10px 14px; border-radius: 8px; background: var(--warn-bg); border: 1px solid var(--warn-border); margin-block: 0 16px; }
  .error { color: var(--danger); margin: 10px 0 0; }
  #missing { padding-block: 16px; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px 16px; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
  label.wide { grid-column: span 2; }
  input { box-sizing: border-box; width: 100%; padding: 8px 10px; font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; }
  input::placeholder { color: var(--muted); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input:focus-visible { border-color: var(--accent); }
  .form-actions { margin-block-start: 14px; }
  button, summary { font: inherit; }
  button { padding: 5px 10px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text); cursor: pointer; white-space: nowrap; }
  button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  button:disabled { opacity: .55; cursor: progress; }
  button.primary { padding: 8px 18px; background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
  button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--on-accent); }
  button.danger { color: var(--danger); border-color: var(--danger-border); }
  button.danger:hover:not(:disabled) { border-color: var(--danger); background: color-mix(in oklab, var(--danger) 8%, transparent); }
  .table-wrapper { overflow: auto; max-block-size: 68vh; border: 1px solid var(--border); border-radius: var(--radius); }
  table { width: 100%; min-width: 1120px; table-layout: fixed; border-collapse: separate; border-spacing: 0; }
  thead th, tbody th, tbody td { box-sizing: border-box; }
  th:nth-child(1) { width: 120px; }
  th:nth-child(3) { width: 220px; }
  th:nth-child(4) { width: 110px; }
  th:nth-child(5) { width: 90px; }
  th:nth-child(6) { width: 160px; }
  th:nth-child(7) { width: 210px; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--thead); padding: 10px 12px; text-align: left; font-size: 12px; font-weight: 600; letter-spacing: .3px; color: var(--muted); white-space: nowrap; border-bottom: 1px solid var(--border); }
  tbody th, tbody td { padding: 8px 12px; text-align: left; vertical-align: middle; border-bottom: 1px solid var(--border); }
  tbody tr:last-child > * { border-bottom: 0; }
  tbody tr:hover > * { background: var(--row-hover); }
  tbody th { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .desc-bar { display: flex; align-items: center; gap: 8px; }
  .desc-bar input { flex: 1; min-width: 120px; }
  .cell-url { word-break: break-all; }
  .cell-time { white-space: nowrap; color: var(--muted); }
  .actions-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .pwd[open] { flex-basis: 100%; }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border: 1px solid; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .badge.on { color: var(--ok); border-color: color-mix(in oklab, var(--ok) 40%, transparent); background: color-mix(in oklab, var(--ok) 10%, transparent); }
  .badge.off { color: var(--muted); border-color: var(--border-strong); }
  .pwd { display: inline-block; }
  .pwd summary { display: inline-block; padding: 5px 10px; border: 1px solid var(--border-strong); border-radius: 8px; cursor: pointer; user-select: none; white-space: nowrap; }
  .pwd summary:hover { border-color: var(--accent); color: var(--accent); }
  .pwd-panel { display: flex; align-items: center; gap: 8px; margin-block-start: 8px; }
  .pwd-panel input { width: 108px; }
  #empty { margin: 4px 0 8px; padding: 20px 0; text-align: center; }
  @media (max-width: 720px) {
    body { padding: 20px 12px 48px; }
    .card { padding: 14px; }
    label.wide { grid-column: auto; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="page-header">
    <h1>e2e 账号池管理</h1>
    <p class="muted">维护 MCP 运行测试时可选用的共享账号；描述字段供测试按用途选择账号。</p>
  </header>

  <p id="notice" class="notice" role="status" hidden></p>
  <p id="missing" class="muted" hidden>地址中没有管理令牌。请使用带 <code>?token=…</code> 的地址打开本页。</p>

  <section class="card">
    <form id="create" hidden>
      <h2>新增账号</h2>
      <div class="fields">
        <label>名称（小写字母、数字、连字符）<input name="name" required maxlength="64" pattern="[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?"></label>
        <label class="wide">描述<input name="description" required maxlength="200"></label>
        <label>URL<input name="url" required type="url" placeholder="https://" spellcheck="false" autocapitalize="none"></label>
        <label>用户名<input name="username" required autocomplete="off" spellcheck="false" autocapitalize="none"></label>
        <label>密码<input name="password" required type="password" autocomplete="new-password"></label>
      </div>
      <div class="form-actions"><button type="submit" class="primary">新增账号</button></div>
      <p id="create-error" class="error" role="alert" hidden></p>
    </form>
  </section>

  <section class="card" id="list-card" hidden>
    <div class="card-head"><h2>账号列表</h2><span id="count" class="muted"></span></div>
    <p id="empty" class="muted" hidden>账号池为空，先在上方新增一个账号。</p>
    <div class="table-wrapper" role="region" aria-label="账号列表" tabindex="0">
      <table id="table" hidden>
        <thead><tr><th scope="col">名称</th><th scope="col">描述</th><th scope="col">URL</th><th scope="col">用户名</th><th scope="col">状态</th><th scope="col">更新时间</th><th scope="col">操作</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </section>
</div>

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
  var listCard = document.getElementById('list-card');
  var count = document.getElementById('count');
  var submitButton = form.querySelector('button[type="submit"]');
  if (token === null || token === '') { missing.hidden = false; return; }
  form.hidden = false;
  listCard.hidden = false;

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

  function when(iso) {
    var date = new Date(iso);
    return isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
  }

  function render(accounts) {
    rows.textContent = '';
    table.hidden = accounts.length === 0;
    empty.hidden = accounts.length !== 0;
    count.textContent = accounts.length === 0 ? '' : '共 ' + accounts.length + ' 个';
    accounts.forEach(function (account) {
      var row = element('tr');
      var nameCell = element('th', account.name);
      nameCell.scope = 'row';
      row.appendChild(nameCell);
      var descriptionCell = element('td');
      var descBar = element('div');
      descBar.className = 'desc-bar';
      var description = element('input');
      description.value = account.description;
      description.maxLength = 200;
      description.setAttribute('aria-label', account.name + ' 的描述');
      descBar.appendChild(description);
      descBar.appendChild(action('保存', function () {
        api('PATCH', '/admin/api/accounts/' + encodeURIComponent(account.name), { description: description.value })
          .then(load).catch(function (error) { showError(error.message); });
      }));
      descriptionCell.appendChild(descBar);
      row.appendChild(descriptionCell);
      var urlCell = element('td', account.url);
      urlCell.className = 'cell-url';
      row.appendChild(urlCell);
      row.appendChild(element('td', account.username));
      var statusCell = element('td');
      var status = element('span', account.enabled ? '启用' : '禁用');
      status.className = account.enabled ? 'badge on' : 'badge off';
      statusCell.appendChild(status);
      row.appendChild(statusCell);
      var timeCell = element('td', when(account.updatedAt));
      timeCell.className = 'cell-time';
      row.appendChild(timeCell);
      var actions = element('td');
      var actionsBar = element('div');
      actionsBar.className = 'actions-bar';
      var pwd = element('details');
      pwd.className = 'pwd';
      pwd.appendChild(element('summary', '改密'));
      var password = element('input');
      password.type = 'password';
      password.autocomplete = 'new-password';
      password.placeholder = '新密码';
      password.setAttribute('aria-label', account.name + ' 的新密码');
      var panel = element('div');
      panel.className = 'pwd-panel';
      panel.appendChild(password);
      panel.appendChild(action('确定', function () {
        if (password.value === '') { showError('新密码不能为空'); return; }
        api('PATCH', '/admin/api/accounts/' + encodeURIComponent(account.name), { password: password.value })
          .then(function () { password.value = ''; pwd.open = false; clearNotice(); load(); })
          .catch(function (error) { showError(error.message); });
      }));
      pwd.appendChild(panel);
      actionsBar.appendChild(pwd);
      actionsBar.appendChild(action(account.enabled ? '禁用' : '启用', function () {
        api('PATCH', '/admin/api/accounts/' + encodeURIComponent(account.name), { enabled: !account.enabled })
          .then(load).catch(function (error) { showError(error.message); });
      }));
      var remove = action('删除', function () {
        if (!confirm('删除账号 ' + account.name + '？')) return;
        api('DELETE', '/admin/api/accounts/' + encodeURIComponent(account.name))
          .then(load).catch(function (error) { showError(error.message); });
      });
      remove.className = 'danger';
      actionsBar.appendChild(remove);
      actions.appendChild(actionsBar);
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
    submitButton.disabled = true;
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
    }).finally(function () {
      submitButton.disabled = false;
    });
  });

  load();
})();
</script>
</body>
</html>
`;
