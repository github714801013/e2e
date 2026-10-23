import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { project: { type: 'string' }, output: { type: 'string' }, pnpm: { type: 'string' } } });
if (!values.project) throw new Error('请传入 --project 测试仓库路径');
const project = path.resolve(values.project);
const output = values.output ? path.resolve(values.output) : mkdtempSync(path.join(tmpdir(), 'e2e-http-deploy-'));
const pnpm = values.pnpm ?? process.env.npm_execpath;
if (!pnpm || !pnpm.includes('pnpm')) throw new Error('请用 --pnpm 传入 pnpm.cjs 或 pnpm.mjs 的完整路径');
const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();
const image = `e2e-http-mcp:${stamp}-${randomUUID().slice(0, 8)}`;
mkdirSync(output, { recursive: true });
const context = path.join(output, 'context');
mkdirSync(context);
const packed = path.join(context, 'project', 'vendor');
mkdirSync(packed, { recursive: true });

/** 子进程直接接收参数，避免路径或配置被解释成 Shell。 */
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, LANG: 'C.UTF-8', PYTHONUTF8: '1', E2E_TELEMETRY_DISABLED: '1' },
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) throw new Error(`执行失败：${command} ${args.join(' ')}\n${result.error?.message ?? result.stderr ?? ''}`);
  return result.stdout?.trim() ?? '';
}

for (const name of ['e2e', '@e2e-dev/web']) {
  run(process.execPath, [pnpm, '--filter', name, 'run', 'build']);
  run(process.execPath, [pnpm, '--filter', name, 'pack', '--pack-destination', packed]);
}
for (const name of ['e2e.config.ts', 'fixtures', 'tests', 'support']) {
  cpSync(path.join(project, name), path.join(context, 'project', name), { recursive: true, dereference: false });
}
const manifest = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
const runner = readdirSync(packed).find((name) => /^e2e-\d/.test(name));
const web = readdirSync(packed).find((name) => name.startsWith('e2e-dev-web-'));
if (!runner || !web) throw new Error('未找到本次构建的框架和 web 引擎安装包');
const dependencies = { ...manifest.dependencies, e2e: `file:vendor/${runner}`, '@e2e-dev/web': `file:vendor/${web}` };
writeFileSync(path.join(context, 'project', 'package.json'), JSON.stringify({ ...manifest, dependencies }, null, 2) + '\n', 'utf8');
copyFileSync(path.join(project, 'package-lock.json'), path.join(context, 'project', 'package-lock.json'));
run(process.execPath, [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(context, 'project'));
copyFileSync(path.join(root, 'deploy', 'http-mcp', 'Dockerfile'), path.join(context, 'Dockerfile'));
run('docker', ['build', '--platform', 'linux/amd64', '--tag', image, context]);
run('docker', ['save', '--output', path.join(output, 'image.tar'), image]);
copyFileSync(path.join(root, 'deploy', 'http-mcp', 'compose.yaml'), path.join(output, 'compose.yaml'));
copyFileSync(path.join(root, 'scripts', 'http-mcp', 'deploy.py'), path.join(output, 'deploy.py'));
run('tar', ['-czf', 'tests.tar.gz', '-C', path.join(context, 'project'), 'tests'], output);
const saved = JSON.parse(run('tar', ['-xOf', 'image.tar', 'manifest.json'], output, true));
const configDigest = /(?:^|\/)([0-9a-f]{64})(?:\.json)?$/.exec(saved[0]?.Config ?? '');
if (!configDigest) throw new Error('镜像归档缺少可校验的配置摘要');
const metadata = {
  image,
  imageId: `sha256:${configDigest[1]}`,
  platform: 'linux/amd64',
  builtAt: new Date().toISOString(),
  frameworkCommit: run('git', ['rev-parse', 'HEAD'], root, true),
  frameworkHasChanges: run('git', ['status', '--porcelain'], root, true) !== '',
  projectCommit: run('git', ['rev-parse', 'HEAD'], project, true),
  projectHasChanges: run('git', ['status', '--porcelain'], project, true) !== '',
  packages: Object.fromEntries([runner, web].map((name) => [name, createHash('sha256').update(readFileSync(path.join(packed, name))).digest('hex')])),
};
writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
const checksums = [];
for (const name of ['image.tar', 'tests.tar.gz', 'compose.yaml', 'deploy.py', 'metadata.json']) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path.join(output, name))) digest.update(chunk);
  checksums.push(`${digest.digest('hex')}  ${name}`);
}
writeFileSync(path.join(output, 'SHA256SUMS'), checksums.join('\n') + '\n', 'utf8');
process.stdout.write(`镜像构建完成：${image}\n部署文件目录：${output}\n`);
