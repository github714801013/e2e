import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  url: { type: 'string' }, ssh: { type: 'string' }, root: { type: 'string' },
  output: { type: 'string' }, recheck: { type: 'string' },
} });
if (!values.url || !values.ssh || !values.root) throw new Error('请传入 --url、--ssh 与 --root');
if (values.url !== 'http://10.1.14.158:18091/mcp/e2e' || values.ssh !== 'root@10.1.14.158' || values.root !== '/data2/project/e2e-http-mcp') {
  throw new Error('验收端点、SSH 目标与根目录必须匹配本次授权的部署，防止凭据误发');
}
const require = createRequire(new URL('../../packages/e2e/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')).href);
const loaded = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '--', values.ssh,
  `python3 -I -c "import json; from pathlib import Path; text=Path('${values.root}/.secrets.env').read_text(); print(json.loads(text.split('=',1)[1])[0]['token'])"`],
{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (loaded.status !== 0) throw new Error('无法通过 SSH 读取部署凭据，未输出命令内容');
const token = loaded.stdout.trim();
if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('服务器凭据格式无效');
const transport = new StreamableHTTPClientTransport(new URL(values.url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: '部署验收', version: '1.0.0' });
const TERMINAL = new Set(['passed', 'failed', 'timed_out', 'interrupted', 'infrastructure_error', 'rejected']);

/** 只输出非秘密的验收事实，协议错误保持脱敏。 */
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 120_000 });
  const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  if (result.isError) throw new Error(`${name} 失败：${text}`);
  return text;
}

/** 从最新观察中解析节点，每次操作后重新读取。 */
async function nodeId(role, name) {
  const tree = await call('call', { tool: 'observe' });
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`#(n\\d+) ${role} "${escaped}"`).exec(tree);
  assert.ok(match, `页面中缺少 ${role} ${name}`);
  return match[1];
}

/** 轮询真实 Job 终态，超时明确失败。 */
async function waitFor(jobId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = JSON.parse(await call('get_test_status', { jobId }));
    if (TERMINAL.has(job.status)) {
      assert.equal(job.status, 'passed', JSON.stringify(job));
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('Job 在两分钟内未结束');
}

try {
  const health = await fetch(new URL('/healthz', values.url), { signal: AbortSignal.timeout(10_000) });
  assert.equal(health.status, 200);
  for (const headers of [{}, { Authorization: 'Bearer ' + 'x'.repeat(64) }]) {
    const refused = await fetch(values.url, { method: 'POST', headers, signal: AbortSignal.timeout(10_000) });
    assert.equal(refused.status, 401);
  }
  const refusedOrigin = await fetch(values.url, { method: 'POST', headers: { Origin: 'https://refused.example' }, signal: AbortSignal.timeout(10_000) });
  assert.equal(refusedOrigin.status, 403);
  process.stdout.write('健康检查 200，缺失/错误 token 401，错误 Origin 403\n');
  await client.connect(transport);

  if (values.recheck) {
    const previous = JSON.parse(readFileSync(values.recheck, 'utf8'));
    const script = JSON.parse(await call('get_test_script', { path: previous.path }));
    assert.equal(script.content, previous.content);
    for (const jobId of previous.jobs) {
      const report = JSON.parse(await call('get_test_report', { jobId }));
      assert.equal(report.status, 'passed');
      assert.ok(report.results.length > 0);
      assert.ok(report.results.every((entry) => entry.status === 'passed'));
    }
    process.stdout.write(`重建后脚本内容与 ${previous.jobs.length} 个 Job 报告保持一致\n`);
  } else {
    const listed = await client.listTools();
    for (const name of ['open_session', 'call', 'list_test_scripts', 'get_test_script', 'save_test_script', 'run_test', 'get_test_status', 'get_test_report']) {
      assert.ok(listed.tools.some((tool) => tool.name === name), `缺少工具 ${name}`);
    }
    assert.ok((await client.listResources()).resources.some((resource) => resource.uri === 'e2e://guide'));
    const opened = await call('open_session', { target: 'demo' });
    assert.ok(opened.includes('open'));
    await call('call', { tool: 'navigate', args: { url: '/' } });
    await call('call', { tool: 'type', args: { target: await nodeId('textbox', '姓名'), value: 'MCP 验收' } });
    await call('call', { tool: 'tap', args: { target: await nodeId('button', '提交问候') } });
    assert.ok((await call('call', { tool: 'observe' })).includes('你好，MCP 验收'));
    process.stdout.write('原生 MCP 浏览器完成输入、点击和页面断言\n');

    const path = `tests/mcp-acceptance-${randomUUID()}.e2e.ts`;
    const content = `import { expect, test } from 'e2e';\n\ntest('MCP 保存的脚本可实际运行', { session: 'tester' }, async ({ app, screen }) => {\n  await app.open('/');\n  await expect(screen.getByRole('heading', 'e2e 部署验收示例')).toBeVisible();\n});\n`;
    const saved = JSON.parse(await call('save_test_script', { path, content }));
    assert.equal(saved.created, true);
    assert.equal(JSON.parse(await call('get_test_script', { path })).content, content);
    const scripts = JSON.parse(await call('list_test_scripts', { prefix: path }));
    assert.equal(scripts.total, 1);
    const duplicate = await client.callTool({ name: 'save_test_script', arguments: { path, content } });
    assert.equal(duplicate.isError, true);
    assert.ok(JSON.stringify(duplicate).includes('SCRIPT_EXISTS'));
    process.stdout.write('脚本保存、读取、列举与拒绝无授权覆盖通过\n');

    const job = JSON.parse(await call('run_test', { targetId: 'demo', testFiles: ['tests/smoke.e2e.ts', path] }));
    await waitFor(job.jobId);
    const report = JSON.parse(await call('get_test_report', { jobId: job.jobId }));
    assert.equal(report.results.length, 3);
    assert.ok(report.results.every((entry) => entry.status === 'passed'));
    const key = `部署验收-${Date.now()}`;
    const once = JSON.parse(await call('run_test', { targetId: 'demo', testFiles: ['tests/smoke.e2e.ts'], idempotencyKey: key }));
    const again = JSON.parse(await call('run_test', { targetId: 'demo', testFiles: ['tests/smoke.e2e.ts'], idempotencyKey: key }));
    assert.equal(once.jobId, again.jobId);
    await waitFor(once.jobId);
    process.stdout.write(`探索会话保持打开时 Job ${job.jobId} 的 3 个测试通过，幂等提交只产生一个 Job\n`);
    await call('close_session');
    if (values.output) writeFileSync(values.output, JSON.stringify({ path, content, jobs: [job.jobId, once.jobId] }, null, 2) + '\n', 'utf8');
  }
} catch (error) {
  process.stderr.write(String(error.message).split(token).join('[已隐藏]') + '\n');
  process.exitCode = 1;
} finally {
  await transport.terminateSession().catch(() => undefined);
  await client.close().catch(() => undefined);
}
