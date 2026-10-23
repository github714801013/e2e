import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: {
  project: { type: 'string' }, pnpm: { type: 'string' }, host: { type: 'string' }, root: { type: 'string' },
  targets: { type: 'string' }, from: { type: 'string' },
} });
const host = values.host ?? 'root@10.1.14.158';
const targetRoot = values.root ?? '/data2/project/e2e-http-mcp';
if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(host)) throw new Error('SSH 目标格式无效');
if (!/^\/[A-Za-z0-9._/-]+$/.test(targetRoot) || targetRoot.includes('..')) throw new Error('部署根目录格式无效');
if (values.from === undefined && (values.project === undefined || values.pnpm === undefined)) {
  throw new Error('首次构建需要 --project 与 --pnpm；只重发已有产物时使用 --from');
}

/** 子进程直接接收参数，避免地址、路径或账号被 Shell 解释。 */
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd: cwd ?? root,
    env: { ...process.env, LANG: 'C.UTF-8', PYTHONUTF8: '1', MSYS_NO_PATHCONV: '1' },
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`执行失败：${command} ${args.join(' ')}`);
  }
}

/** 地址和账号文件在本地校验，避免坏配置进入服务器。 */
function validateTargets(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取外部地址文件：${error.message}`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error('外部地址文件根节点必须是数组');
  const names = new Set();
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`第 ${index + 1} 项必须是对象`);
    const keys = Object.keys(entry);
    for (const key of keys) {
      if (!['name', 'url', 'username', 'password'].includes(key)) throw new Error(`第 ${index + 1} 项包含未知字段 ${key}`);
    }
    if (typeof entry.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) throw new Error(`第 ${index + 1} 项 name 无效`);
    if (entry.name === 'demo' || names.has(entry.name)) throw new Error(`第 ${index + 1} 项 name 重复或占用了 demo`);
    names.add(entry.name);
    if (typeof entry.url !== 'string') throw new Error(`第 ${index + 1} 项 url 无效`);
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error(`第 ${index + 1} 项 url 无效`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`第 ${index + 1} 项只支持 http 或 https`);
    if (typeof entry.username !== 'string' || entry.username.trim() === '') throw new Error(`第 ${index + 1} 项 username 为空`);
    if (typeof entry.password !== 'string' || [...entry.password].length < 6) throw new Error(`第 ${index + 1} 项 password 少于 6 个字符`);
  });
}

const targets = values.targets === undefined ? undefined : path.resolve(values.targets);
if (targets !== undefined) validateTargets(targets);
const output = values.from === undefined
  ? mkdtempSync(path.join(tmpdir(), 'e2e-http-deploy-'))
  : path.resolve(values.from);
if (values.from === undefined) {
  run(process.execPath, [path.join(root, 'scripts/http-mcp/build.mjs'), '--project', path.resolve(values.project), '--pnpm', values.pnpm, '--output', output]);
}
const metadata = JSON.parse(readFileSync(path.join(output, 'metadata.json'), 'utf8'));
const release = String(metadata.image).split(':')[1];
if (!/^[A-Za-z0-9._-]+$/.test(release)) throw new Error('镜像标签无法作为 release 名称');
const files = ['image.tar', 'tests.tar.gz', 'compose.yaml', 'deploy.py', 'metadata.json', 'SHA256SUMS'];
for (const name of files) {
  if (!existsSync(path.join(output, name))) throw new Error(`构建目录缺少 ${name}`);
}
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
const remote = `${targetRoot}/releases/${release}`;
const ssh = (command) => run('ssh', [...sshOptions, host, command]);

ssh(`umask 077; mkdir -p '${remote}'`);
// Windows 的盘符冒号会被 scp 当成远程主机，源文件用相对路径从构建目录发送。
run('scp', [...sshOptions, ...files, `${host}:${remote}/`], output);
ssh(`cd '${remote}' && sha256sum -c SHA256SUMS`);
if (targets !== undefined) {
  ssh(`install -d -o 1000 -g 1000 -m 700 '${targetRoot}/targets'`);
  run('scp', [...sshOptions, path.basename(targets), `${host}:${remote}/.targets.json`], path.dirname(targets));
  ssh(`install -o 1000 -g 1000 -m 600 '${remote}/.targets.json' '${targetRoot}/targets/targets.json' && rm -f '${remote}/.targets.json'`);
}
ssh(`LANG=C.UTF-8 PYTHONUTF8=1 python3 -I '${remote}/deploy.py' --root '${targetRoot}' --release '${remote}'`);
process.stdout.write(`部署完成：http://${host.split('@')[1]}:18091/mcp/e2e\n`);
process.stdout.write(`镜像：${metadata.image}\n构建目录：${output}\n`);
