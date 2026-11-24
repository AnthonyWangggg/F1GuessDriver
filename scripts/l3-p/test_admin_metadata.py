"""Synthetic filesystem/process fixtures only; never calls systemctl, SQL or the network."""
import importlib.util
import json
import pathlib
import tempfile
import types
import unittest
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('collector', pathlib.Path(__file__).with_name('admin-metadata.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
guard_spec = importlib.util.spec_from_file_location('guard', pathlib.Path(__file__).with_name('linux-unit-preflight.py'))
guard = importlib.util.module_from_spec(guard_spec)
guard_spec.loader.exec_module(guard)


class MetadataTests(unittest.TestCase):
    def test_negative_bpf_build_fails_closed(self):
        self.assertEqual(guard.check_build('systemd 255\n+SECCOMP -BPF_FRAMEWORK', 'linux')['status'], 'BLOCKED')

    def test_unknown_or_nonlinux_build_fails_closed(self):
        for version, platform in [('systemd 255', 'linux'), ('+BPF_FRAMEWORK', 'win32')]:
            self.assertEqual(guard.check_build(version, platform)['status'], 'BLOCKED')

    def test_positive_build_is_not_a_runtime_or_permission_pass(self):
        result = guard.check_build('systemd 255\n+SECCOMP +BPF_FRAMEWORK', 'linux')
        self.assertEqual(result['status'], 'ELIGIBLE_FOR_RUNTIME_CHECK')
        self.assertEqual(result['runtimeEnforcement'], 'NOT_RUN')

    def test_permission_failure_has_no_raw_exception(self):
        with patch.object(collector, 'read_small', side_effect=PermissionError('sensitive-value')):
            with tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder)
                (root / 'routing/current').mkdir(parents=True)
                result = collector.routing(root)
        self.assertEqual(result['diskEvidence']['category'], 'PermissionError')
        self.assertNotIn('sensitive-value', json.dumps(result))

    def test_disk_artifacts_are_not_claimed_as_loaded(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            current = root / 'routing/current'; current.mkdir(parents=True)
            release = root / 'releases/test'; release.mkdir(parents=True)
            (root / 'manifests').mkdir()
            state = dict(slot='blue', generation='g-test', web='test', server='test', dataset='synthetic')
            (current / 'state.json').write_text(json.dumps(state))
            (current / 'upstream.inc').write_text('upstream test { server 127.0.0.1:3000; }')
            (current / 'site.inc').write_text('root /not-exported;')
            files = {}
            for name, body in [('apps/server/dist/index.js', 'synthetic'), ('apps/web/dist/index.html', '<html>synthetic</html>')]:
                path = release / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(body)
                files[name] = collector.digest(body.encode())
            (root / 'manifests/test.json').write_text(json.dumps(dict(schema=1, id='test', files=files, secret='not-exported')))
            result = collector.routing(root)
        self.assertEqual(result['diskRouting']['status'], 'PASS')
        self.assertEqual(result['loadedConfiguration']['status'], 'BLOCKED')
        self.assertEqual(result['artifacts']['server']['sourceEvidence'], 'BLOCKED-missing')
        self.assertNotIn('not-exported', json.dumps(result))

    def receipt(self, **overrides):
        return dict(schema='backup-receipt-v1', status='success', completedAt='2026-01-01T00:00:00Z',
                    bytes=100, sha256='a'*64, coverage=['database', 'roles'], keyIds=['test-only'],
                    roles=['test-role'], retentionDays=7, offsiteReceiptPresent=False, **overrides)

    def test_existing_receipt_never_verifies_body_or_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            p = pathlib.Path(folder) / 'synthetic.receipt.json'; p.write_text(json.dumps(self.receipt()))
            result = collector.receipt(p)
        self.assertFalse(result['backupBodyRead'])
        self.assertFalse(result['backupHashRecomputed'])
        self.assertEqual(result['restoreProof'], 'BLOCKED')

    def test_dump_and_extra_secret_fields_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            p = pathlib.Path(folder) / 'synthetic.dump'
            with self.assertRaises(ValueError): collector.receipt(p)
            p = pathlib.Path(folder) / 'synthetic.receipt.json'
            p.write_text(json.dumps(self.receipt(password='not-exported')))
            with self.assertRaises(ValueError): collector.receipt(p)

    def test_size_and_symlink_refused_before_read(self):
        with tempfile.TemporaryDirectory() as folder:
            p = pathlib.Path(folder) / 'input'; p.write_bytes(b'x'*20)
            with self.assertRaises(ValueError): collector.read_small(p, 10)
            with patch.object(pathlib.Path, 'is_symlink', return_value=True):
                with self.assertRaises(ValueError): collector.read_small(p)

    def test_cert_failure_is_category_only(self):
        result = types.SimpleNamespace(stdout='ActiveState=failed\nResult=exit-code\nExecMainStatus=1\nExecMainExitTimestamp=Tue 2026-01-01 00:00:00 CST\nEnvironment=not-exported\n')
        with patch.object(collector.subprocess, 'run', return_value=result) as run:
            output = collector.certificate_status()
            self.assertNotIn('not-exported', json.dumps(output))
            self.assertEqual(output['failedComponent'], 'BLOCKED-no-classification')
            self.assertNotIn('journalctl', run.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
