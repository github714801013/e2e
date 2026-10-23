"""验证部署更新不会覆盖 MCP 保存的脚本。"""

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.stdout.reconfigure(encoding='utf-8')
spec = importlib.util.spec_from_file_location('http_mcp_deploy', Path(__file__).with_name('deploy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DeploymentFilesTest(unittest.TestCase):
    def test_rejects_changed_added_and_deleted_scripts(self):
        """真实文件的新增、改写和删除都必须阻止部署。"""
        with tempfile.TemporaryDirectory(prefix='e2e-deploy-check-') as temporary:
            root = Path(temporary)
            script = root / 'smoke.e2e.ts'
            script.write_text('原始脚本', encoding='utf-8')
            baseline = module.snapshot(root)
            module.check_unchanged(root, baseline)
            for mode in ['changed', 'added', 'deleted']:
                with self.subTest(mode=mode):
                    script.write_text('原始脚本', encoding='utf-8')
                    extra = root / 'mcp.e2e.ts'
                    if extra.exists():
                        extra.unlink()
                    if mode == 'changed':
                        script.write_text('MCP 修改', encoding='utf-8')
                    elif mode == 'added':
                        extra.write_text('MCP 新建', encoding='utf-8')
                    else:
                        script.unlink()
                    with self.assertRaisesRegex(RuntimeError, '已保留并停止部署'):
                        module.check_unchanged(root, baseline)
            with self.assertRaisesRegex(RuntimeError, '已保留并停止部署'):
                module.check_unchanged(root / 'missing-tests', baseline)


    @unittest.skipIf(sys.platform == 'win32', 'Windows 无法验证容器 UID 权限')
    def test_targets_file_is_private_to_container_user(self):
        """地址和账号文件只能由容器用户读取，其他权限被拒绝。"""
        with tempfile.TemporaryDirectory(prefix='e2e-targets-') as temporary:
            directory = Path(temporary) / 'targets'
            directory.mkdir()
            os.chown(str(directory), 1000, 1000)
            os.chmod(str(directory), 0o700)
            module.check_targets(directory)
            target = directory / 'targets.json'
            target.write_text('[]', encoding='utf-8')
            os.chown(str(target), 1000, 1000)
            os.chmod(str(target), 0o600)
            module.check_targets(directory)
            os.chmod(str(target), 0o644)
            with self.assertRaisesRegex(RuntimeError, 'targets.json 权限'):
                module.check_targets(directory)

    @unittest.skipIf(sys.platform == 'win32', 'Windows 创建文件链接需要额外权限')
    def test_rejects_directory_and_file_symlinks(self):
        """链接不能让权限修复越过测试目录。"""
        with tempfile.TemporaryDirectory(prefix='e2e-deploy-links-') as temporary:
            root = Path(temporary)
            target = root / 'target'
            target.mkdir()
            link = root / 'linked'
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, '符号链接'):
                module.snapshot(link)
            file = target / 'fixture.e2e.ts'
            file.symlink_to(root / 'outside')
            with self.assertRaisesRegex(RuntimeError, '符号链接'):
                module.snapshot(target)


    def test_switch_recovers_failures_and_preserves_online_edits(self):
        """服务切换失败恢复旧文件，启动期间保存的脚本不进入部署基线。"""
        for mode in ['startup', 'copy', 'baseline', 'stop', 'concurrent', 'saved']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='e2e-switch-') as temporary:
                root = Path(temporary)
                tests = root / 'tests'
                tests.mkdir()
                script = tests / 'smoke.e2e.ts'
                script.write_text('旧脚本', encoding='utf-8')
                baseline = module.snapshot(tests)
                baseline_path = root / '.tests-baseline.json'
                baseline_path.write_text(json.dumps(baseline), encoding='utf-8')
                (root / '.deploy.env').write_text('E2E_IMAGE=old\n', encoding='utf-8')
                (root / 'compose.yaml').write_text('旧配置', encoding='utf-8')
                release = root / 'release'
                incoming = release / 'incoming' / 'tests'
                incoming.mkdir(parents=True)
                (incoming / script.name).write_text('新脚本', encoding='utf-8')
                expected = module.snapshot(incoming)
                candidate = release / '.tests-baseline.json'
                candidate.write_text(json.dumps(expected), encoding='utf-8')
                (release / '.deploy.env').write_text('E2E_IMAGE=new\n', encoding='utf-8')
                (release / 'compose.yaml').write_text('新配置', encoding='utf-8')
                starts = 0
                stops = 0

                def command(_root, *args):
                    """只替代 Docker 进程边界，磁盘切换使用真实文件。"""
                    nonlocal starts, stops
                    if args[0] == 'stop':
                        stops += 1
                        if mode == 'concurrent' and stops == 1:
                            script.write_text('在线修改', encoding='utf-8')
                        if mode == 'stop' and stops == 2:
                            raise RuntimeError('Docker 不可用')
                    else:
                        starts += 1
                        if starts == 1 and mode in ['startup', 'stop']:
                            raise RuntimeError('新服务启动失败')
                        if starts == 1 and mode == 'saved':
                            (tests / 'mcp.e2e.ts').write_text('在线保存', encoding='utf-8')

                original_copy = module.shutil.copyfile
                original_replace = Path.replace

                def copy(source, target):
                    if mode == 'copy' and source == str(release / 'compose.yaml'):
                        raise OSError('复制失败')
                    return original_copy(source, target)

                def replace(source, target):
                    if mode == 'baseline' and source == candidate:
                        raise OSError('摘要写入失败')
                    return original_replace(source, target)

                with patch.object(module, 'compose', side_effect=command), patch.object(module.shutil, 'copyfile', side_effect=copy), patch.object(Path, 'replace', replace):
                    if mode == 'saved':
                        module.activate(root, release, baseline)
                    else:
                        with self.assertRaises(Exception):
                            module.activate(root, release, baseline)
                if mode == 'saved':
                    self.assertEqual(json.loads(baseline_path.read_text(encoding='utf-8')), expected)
                    with self.assertRaisesRegex(RuntimeError, '已保留并停止部署'):
                        module.check_unchanged(tests, expected)
                elif mode == 'stop':
                    self.assertEqual(script.read_text(encoding='utf-8'), '新脚本')
                    self.assertTrue((release / 'previous-tests' / script.name).exists())
                    self.assertEqual(json.loads(baseline_path.read_text(encoding='utf-8')), baseline)
                else:
                    self.assertEqual(script.read_text(encoding='utf-8'), '在线修改' if mode == 'concurrent' else '旧脚本')
                    self.assertEqual((root / '.deploy.env').read_text(encoding='utf-8'), 'E2E_IMAGE=old\n')
                    self.assertEqual((root / 'compose.yaml').read_text(encoding='utf-8'), '旧配置')
                    self.assertEqual(json.loads(baseline_path.read_text(encoding='utf-8')), baseline)
                    self.assertEqual(starts, 1 if mode == 'copy' or mode == 'concurrent' else 2)


if __name__ == '__main__':
    unittest.main()
