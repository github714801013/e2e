import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync, cpSync, createReadStream, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, readlinkSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
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
let image = `e2e-http-mcp:${stamp}-${randomUUID().slice(0, 8)}`;
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

/** 目录的稳定摘要：按相对路径排序，文件内容与链接目标都参与。 */
function digestTree(directory) {
  const digest = createHash('sha256');
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) digest.update(`${relative}\0link\0${readlinkSync(absolute)}\0`);
      else if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) digest.update(`${relative}\0file\0${createHash('sha256').update(readFileSync(absolute)).digest('hex')}\0`);
    }
  };
  walk(directory);
  return digest.digest('hex');
}

function digestFile(base, relative) {
  try {
    return createHash('sha256').update(readFileSync(path.join(base, relative))).digest('hex');
  } catch {
    return 'missing';
  }
}

/** 镜像与 vendor 包的输入：框架源码、构建配置、Dockerfile，以及项目的非 tests 文件。 */
function imageKey() {
  const digest = createHash('sha256');
  for (const directory of ['packages/e2e/src', 'packages/e2e/scripts', 'packages/web/src']) {
    digest.update(`${directory}\0${digestTree(path.join(root, directory))}\0`);
  }
  for (const name of readdirSync(path.join(root, 'packages/e2e'))) {
    if (name.endsWith('.json')) digest.update(`packages/e2e/${name}\0${digestFile(root, `packages/e2e/${name}`)}\0`);
  }
  for (const name of readdirSync(path.join(root, 'packages/web'))) {
    if (name.endsWith('.json')) digest.update(`packages/web/${name}\0${digestFile(root, `packages/web/${name}`)}\0`);
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'scripts/stamp-dist.ts', 'deploy/http-mcp/Dockerfile']) {
    digest.update(`${name}\0${digestFile(root, name)}\0`);
  }
  for (const name of ['e2e.config.ts', 'package.json', 'package-lock.json']) {
    digest.update(`project/${name}\0${digestFile(project, name)}\0`);
  }
  for (const name of ['fixtures', 'support']) {
    digest.update(`project/${name}\0${digestTree(path.join(project, name))}\0`);
  }
  return digest.digest('hex');
}

/** 同盘硬链接，失败时退回复制。 */
function linkOrCopy(source, target) {
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

/** 保留最近 `keep` 个缓存条目。 */
function prune(directory, keep) {
  try {
    const entries = readdirSync(directory, { withFileTypes: true })
      .map((entry) => ({ path: path.join(directory, entry.name), time: statSync(path.join(directory, entry.name)).mtimeMs }))
      .toSorted((left, right) => right.time - left.time);
    for (const entry of entries.slice(keep)) rmSync(entry.path, { recursive: true, force: true });
  } catch {
    // 缓存清理失败不影响本次构建。
  }
}

const cacheRoot = path.join(tmpdir(), 'e2e-http-mcp-cache');
const imageCache = path.join(cacheRoot, 'images', imageKey());
const testsKey = digestTree(path.join(project, 'tests'));
const testsCache = path.join(cacheRoot, 'tests', `${testsKey}.tar.gz`);
mkdirSync(path.dirname(testsCache), { recursive: true });

/** 只记录构建输入与产物身份；缓存复用时保留镜像身份，刷新运行态字段。 */
function describe(metadata) {
  return {
    ...metadata,
    builtAt: new Date().toISOString(),
    frameworkCommit: run('git', ['rev-parse', 'HEAD'], root, true),
    frameworkHasChanges: run('git', ['status', '--porcelain'], root, true) !== '',
    projectCommit: run('git', ['rev-parse', 'HEAD'], project, true),
    projectHasChanges: run('git', ['status', '--porcelain'], project, true) !== '',
  };
}

let metadata;
if (existsSync(path.join(imageCache, 'image.tar')) && existsSync(path.join(imageCache, 'metadata.json'))) {
  const cached = JSON.parse(readFileSync(path.join(imageCache, 'metadata.json'), 'utf8'));
  image = cached.image;
  linkOrCopy(path.join(imageCache, 'image.tar'), path.join(output, 'image.tar'));
  metadata = describe(cached);
  process.stdout.write(`镜像缓存命中（${path.basename(imageCache).slice(0, 12)}），跳过构建与导出：${image}\n`);
} else {
  for (const name of ['e2e', '@e2e-dev/web']) {
    run(process.execPath, [pnpm, '--filter', name, 'run', 'build']);
    run(process.execPath, [pnpm, '--filter', name, 'pack', '--pack-destination', packed]);
  }
  for (const name of ['e2e.config.ts', 'fixtures', 'support']) {
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
  // 相对路径：Windows 盘符会让 GNU tar 把它当成远程主机。
  const saved = JSON.parse(run('tar', ['-xOf', 'image.tar', 'manifest.json'], output, true));
  const configDigest = /(?:^|\/)([0-9a-f]{64})(?:\.json)?$/.exec(saved[0]?.Config ?? '');
  if (!configDigest) throw new Error('镜像归档缺少可校验的配置摘要');
  metadata = describe({
    image,
    imageId: `sha256:${configDigest[1]}`,
    platform: 'linux/amd64',
    builtAt: new Date().toISOString(),
    frameworkCommit: '',
    frameworkHasChanges: false,
    projectCommit: '',
    projectHasChanges: false,
    packages: Object.fromEntries([runner, web].map((name) => [name, createHash('sha256').update(readFileSync(path.join(packed, name))).digest('hex')])),
  });
  mkdirSync(imageCache, { recursive: true });
  linkOrCopy(path.join(output, 'image.tar'), path.join(imageCache, 'image.tar'));
  writeFileSync(path.join(imageCache, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  prune(path.join(cacheRoot, 'images'), 2);
}

copyFileSync(path.join(root, 'deploy', 'http-mcp', 'compose.yaml'), path.join(output, 'compose.yaml'));
copyFileSync(path.join(root, 'scripts', 'http-mcp', 'deploy.py'), path.join(output, 'deploy.py'));
if (existsSync(testsCache)) {
  linkOrCopy(testsCache, path.join(output, 'tests.tar.gz'));
} else {
  run('tar', ['-czf', 'tests.tar.gz', '-C', project, 'tests'], output);
  linkOrCopy(path.join(output, 'tests.tar.gz'), testsCache);
  prune(path.dirname(testsCache), 4);
}
writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
const checksums = [];
for (const name of ['image.tar', 'tests.tar.gz', 'compose.yaml', 'deploy.py', 'metadata.json']) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path.join(output, name))) digest.update(chunk);
  checksums.push(`${digest.digest('hex')}  ${name}`);
}
writeFileSync(path.join(output, 'SHA256SUMS'), checksums.join('\n') + '\n', 'utf8');
process.stdout.write(`镜像构建完成：${image}\n部署文件目录：${output}\n`);
