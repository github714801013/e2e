#!/usr/bin/env python3
"""在专用部署目录内更新镜像，先核对测试脚本，保留数据和旧版本。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

TOOLS = ['open_session', 'tools', 'call', 'close_session', 'list_test_scripts',
         'get_test_script', 'save_test_script', 'run_test', 'get_test_status', 'get_test_report']


def snapshot(directory):
    """对测试目录的文件内容建摘要，拒绝符号链接。"""
    if directory.is_symlink():
        raise RuntimeError('管理目录不接受符号链接')
    result = {}
    for current, directories, files in os.walk(str(directory)):
        for name in directories + files:
            item = Path(current) / name
            if item.is_symlink():
                raise RuntimeError('测试目录不接受符号链接：' + str(item.relative_to(directory)))
        for name in files:
            item = Path(current) / name
            if not item.is_file():
                raise RuntimeError('测试目录存在非普通文件')
            result[item.relative_to(directory).as_posix()] = hashlib.sha256(item.read_bytes()).hexdigest()
    return result


def check_unchanged(directory, baseline):
    """服务器上的新增、删除或修改均阻止覆盖。"""
    current = snapshot(directory)
    changed = sorted(name for name in set(current) | set(baseline) if current.get(name) != baseline.get(name))
    if changed:
        raise RuntimeError('服务器脚本有未审阅修改，已保留并停止部署：' + ', '.join(changed))


def compose(root, *args):
    """固定项目名和配置文件，避免影响其他服务。"""
    subprocess.check_call(['docker', 'compose', '-p', 'e2e-http-mcp', '--project-directory', str(root),
                           '--env-file', str(root / '.deploy.env'), '-f', str(root / 'compose.yaml')] + list(args))


def own(directory):
    """仅调整本服务测试和数据目录，容器使用 UID 1000。"""
    snapshot(directory)
    os.chown(str(directory), 1000, 1000, follow_symlinks=False)
    os.chmod(str(directory), 0o700)
    for current, directories, files in os.walk(str(directory)):
        for name in directories + files:
            item = Path(current) / name
            os.chown(str(item), 1000, 1000)
            os.chmod(str(item), 0o700 if item.is_dir() else 0o600)


def check_project(root):
    """同名 Compose 项目只能属于已授权目录。"""
    ids = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=e2e-http-mcp']).decode('utf-8').split()
    if not ids:
        return
    labels = subprocess.check_output(['docker', 'inspect', '--format', '{{json .Config.Labels}}'] + ids).decode('utf-8').splitlines()
    for line in labels:
        value = json.loads(line)
        if value.get('com.docker.compose.project.working_dir') != str(root) or value.get('com.docker.compose.project.config_files') != str(root / 'compose.yaml'):
            raise RuntimeError('同名 Compose 项目属于其他目录，拒绝停止或覆盖')


def check_credential(credential):
    """只复用 root 拥有的普通凭据文件。"""
    info = credential.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
        raise RuntimeError('凭据必须是 root 拥有的普通文件，不能是符号链接')
    os.chmod(str(credential), 0o600)


def check_targets(directory):
    """外部地址文件由容器用户读取，不能暴露给其他主机用户。"""
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 1000:
        raise RuntimeError('targets 必须是 UID 1000 拥有的普通目录')
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('targets 目录权限必须是 0700')
    target = directory / 'targets.json'
    if not target.exists():
        return
    info = target.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 1000:
        raise RuntimeError('targets.json 必须是 UID 1000 拥有的普通文件')
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('targets.json 权限必须是 0600 或更严格')


def activate(root, release, baseline):
    """切换服务，失败时恢复旧脚本；无法确认停服时保留现场。"""
    tests = root / 'tests'
    backup = release / 'previous-tests'
    deploy_env = root / '.deploy.env'
    previous = deploy_env.read_bytes() if deploy_env.exists() else None
    previous_compose = (root / 'compose.yaml').read_bytes() if previous is not None else None
    replaced = False
    try:
        if previous is not None:
            compose(root, 'stop', '--timeout', '150')
        if baseline is not None:
            check_unchanged(tests, baseline)
        if tests.exists():
            tests.rename(backup)
        (release / 'incoming' / 'tests').rename(tests)
        replaced = True
        shutil.copyfile(str(release / 'compose.yaml'), str(root / 'compose.yaml'))
        shutil.copyfile(str(release / '.deploy.env'), str(deploy_env))
        os.chmod(str(deploy_env), 0o600)
        compose(root, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120')
        (release / '.tests-baseline.json').replace(root / '.tests-baseline.json')
    except Exception as failure:
        if replaced:
            try:
                compose(root, 'stop', '--timeout', '150')
            except Exception as stopping:
                raise RuntimeError('未完成回滚、服务状态未知；部署目录：' + str(root) +
                                   '；旧脚本备份：' + (str(backup) if backup.exists() else '首次部署无旧脚本') +
                                   '；原始失败：' + str(failure) + '；停服失败：' + str(stopping)) from stopping
            tests.rename(release / 'failed-tests')
        if backup.exists():
            backup.rename(tests)
        if previous is not None:
            deploy_env.write_bytes(previous)
            (root / 'compose.yaml').write_bytes(previous_compose)
            compose(root, 'up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '120')
            print('部署失败，已恢复原镜像和脚本；数据目录保留。')
        raise


def main():
    """导入已构建镜像，停止旧实例后再次核对，原子替换脚本目录。"""
    import fcntl

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    root = Path(args.root)
    if str(root) != '/data2/project/e2e-http-mcp' or root.resolve() != root:
        raise RuntimeError('部署根目录必须是已授权路径，不能包含符号链接')
    if os.geteuid() != 0:
        raise RuntimeError('本部署程序需要 root 执行目录与 Docker 管理')
    release = Path(args.release).resolve()
    if release.parent != root / 'releases':
        raise RuntimeError('release 必须位于本服务的 releases 目录')
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(str(root), 0o700)
    check_project(root)
    with (root / '.deploy.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        tests = root / 'tests'
        baseline_path = root / '.tests-baseline.json'
        for managed in [root / 'state', root / 'tests', root / 'targets', baseline_path, root / '.deploy.env', root / 'compose.yaml', root / '.secrets.env']:
            if managed.is_symlink():
                raise RuntimeError('管理路径不接受符号链接：' + managed.name)
        credential = root / '.secrets.env'
        if credential.exists():
            check_credential(credential)
        baseline = None
        if tests.exists() or baseline_path.exists():
            if not baseline_path.exists():
                raise RuntimeError('已有测试目录但没有部署摘要，拒绝覆盖')
            baseline = json.loads(baseline_path.read_text(encoding='utf-8'))
            check_unchanged(tests, baseline)
        incoming = release / 'incoming'
        incoming.mkdir()
        with tarfile.open(str(release / 'tests.tar.gz')) as archive:
            for member in archive.getmembers():
                parts = Path(member.name).parts
                if not parts or parts[0] != 'tests' or '..' in parts or not (member.isfile() or member.isdir()):
                    raise RuntimeError('测试归档包含无效路径或链接')
            archive.extractall(str(incoming))
        incoming_baseline = snapshot(incoming / 'tests')
        metadata = json.loads((release / 'metadata.json').read_text(encoding='utf-8'))
        subprocess.check_call(['docker', 'load', '--input', str(release / 'image.tar')])
        actual = subprocess.check_output(['docker', 'image', 'inspect', metadata['image'], '--format', '{{.Id}}']).decode('utf-8').strip()
        if actual != metadata['imageId']:
            raise RuntimeError('镜像摘要不一致')
        own(incoming / 'tests')
        state = root / 'state'
        if not state.exists():
            state.mkdir()
            os.chown(str(state), 1000, 1000)
            os.chmod(str(state), 0o700)
        targets = root / 'targets'
        if not targets.exists():
            targets.mkdir()
            os.chown(str(targets), 1000, 1000)
            os.chmod(str(targets), 0o700)
        check_targets(targets)
        if not credential.exists():
            token = secrets.token_hex(32)
            records = [{'token': token, 'principal': 'team', 'tools': TOOLS}]
            with credential.open('x', encoding='utf-8') as output:
                output.write('E2E_HTTP_MCP_TOKENS=' + json.dumps(records, separators=(',', ':')) + '\n')
            os.chmod(str(credential), 0o600)
        candidate_env = release / '.deploy.env'
        candidate_env.write_text('E2E_IMAGE=' + metadata['image'] + '\n', encoding='utf-8')
        (release / '.tests-baseline.json').write_text(json.dumps(incoming_baseline, indent=2) + '\n', encoding='utf-8')
        subprocess.check_call(['docker', 'compose', '-p', 'e2e-http-mcp', '--project-directory', str(root),
                               '--env-file', str(candidate_env), '-f', str(release / 'compose.yaml'), 'config', '--quiet'])
        activate(root, release, baseline)
        print('部署完成：http://10.1.14.158:18091/mcp/e2e')
        print('凭据保存在服务器 .secrets.env，未输出到日志；旧脚本保存在本次 release 内。')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        sys.stderr.write('部署失败：' + str(error) + '\n')
        sys.exit(1)
