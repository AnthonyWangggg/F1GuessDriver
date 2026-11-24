"""Bounded startup probes: fake clocks/commands, real private evidence files."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import first_prod as fp
import release as ops


CFG = {'prod': {'port': 3101, 'domain': 'f1driverguess.online'}}
RUNNING = 'ActiveState=active\nSubState=running\nMainPID=123\nNRestarts=0\nResult=success\n'


class StartupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.clock = 0
        self.calls = []
        self.health = ['200']
        self.ready = ['200']
        self.states = [RUNNING]
        for target, attribute, value in [
            (fp, 'home', lambda: self.root),
            (fp.time, 'monotonic', lambda: self.clock),
            (fp.time, 'sleep', self.sleep),
            (ops, 'run', self.command),
            (fp.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 0, b'journal', b'')),
        ]:
            p = patch.object(target, attribute, side_effect=value) if callable(value) else patch.object(target, attribute, value)
            p.start()
            self.addCleanup(p.stop)

    def sleep(self, seconds):
        self.assertGreater(seconds, 0)
        self.assertLessEqual(seconds, 1)
        self.clock += seconds

    def next_value(self, values):
        return values.pop(0) if len(values) > 1 else values[0]

    def command(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        self.assertLessEqual(kwargs['timeout'], 2)
        if args[0] == 'systemctl':
            value = self.next_value(self.states)
            if isinstance(value, Exception):
                raise value
            return subprocess.CompletedProcess(args, 0, value)
        self.assertEqual(args[0], 'curl')
        self.assertNotIn('--retry', args)
        values = self.health if args[-1].endswith('/health') else self.ready
        value = self.next_value(values)
        if isinstance(value, Exception):
            raise value
        return subprocess.CompletedProcess(args, 0, value.encode())

    def receipt(self):
        paths = list(self.root.glob('startup-*/readiness.json'))
        self.assertEqual(len(paths), 1)
        return json.loads(paths[0].read_text())

    def test_connection_refusal_then_health_and_ready_pass(self):
        self.health = [subprocess.CalledProcessError(7, ['curl']), '200', '200']
        self.ready = ['503', '503', '200']
        result = fp.wait_ready(CFG)
        self.assertEqual(result['result'], 'PASS')
        self.assertEqual(self.clock, 2)
        self.assertEqual(len(result['attempts']), 3)
        self.assertEqual(self.receipt()['attempts'][0]['probes'][0]['exitCode'], 7)
        self.assertFalse(any(c[0][0] == 'systemctl' and c[0][1] != 'show' for c in self.calls))

    def test_health_without_ready_never_passes(self):
        self.ready = ['503', '503', '200']
        with patch.object(fp, 'https_probe', return_value=None) as https:
            fp.probe(CFG, True, False)
        https.assert_called_once_with(CFG, True, False)
        self.assertEqual(self.clock, 2)
        self.assertEqual(len(self.receipt()['attempts']), 3)

    def test_transient_502_is_not_success(self):
        self.health = ['502', '200']
        self.assertEqual(fp.wait_ready(CFG)['result'], 'PASS')
        self.assertEqual(self.clock, 1)

    def test_failed_service_exits_before_http(self):
        self.states = ['ActiveState=failed\nSubState=failed\nMainPID=0\nNRestarts=0\nResult=exit-code\n']
        with self.assertRaisesRegex(RuntimeError, 'exited or failed'):
            fp.wait_ready(CFG)
        self.assertFalse(any(c[0][0] == 'curl' for c in self.calls))
        self.assertEqual(self.receipt()['result'], 'FAIL')

    def test_exit_during_probe_does_not_accept_old_200s(self):
        self.states = [RUNNING, 'ActiveState=inactive\nSubState=dead\nMainPID=0\nNRestarts=0\nResult=success\n']
        with self.assertRaisesRegex(RuntimeError, 'exited or failed'):
            fp.wait_ready(CFG)

    def test_automatic_restart_is_rejected(self):
        self.states = [RUNNING, RUNNING.replace('MainPID=123', 'MainPID=456').replace('NRestarts=0', 'NRestarts=1')]
        with self.assertRaisesRegex(RuntimeError, 'restarted'):
            fp.wait_ready(CFG)

    def test_timeout_is_60_seconds_and_preserves_complete_diagnostics(self):
        self.ready = ['503']
        with self.assertRaisesRegex(RuntimeError, 'timed out'):
            fp.wait_ready(CFG)
        self.assertEqual(self.clock, 60)
        r = self.receipt()
        self.assertEqual(r['elapsedSeconds'], 60)
        folder = Path(r['evidenceDirectory'])
        for name in ['journal.stdout', 'journal.stderr', 'systemd.stdout', 'ports.stdout']:
            self.assertTrue((folder / name).exists())
        self.assertEqual(len(r['attempts']), 60)

    def test_request_timeouts_share_the_total_deadline(self):
        original = self.command
        def command(*args, **kwargs):
            if args[0] == 'curl':
                self.clock += kwargs['timeout']
                raise subprocess.TimeoutExpired(args, kwargs['timeout'])
            return original(*args, **kwargs)
        with patch.object(ops, 'run', side_effect=command), self.assertRaisesRegex(RuntimeError, 'timed out'):
            fp.wait_ready(CFG)
        self.assertEqual(self.clock, 60)

    def test_permanent_http_error_fails_without_waiting(self):
        self.ready = ['404']
        with self.assertRaisesRegex(RuntimeError, 'Unrecoverable startup HTTP'):
            fp.wait_ready(CFG)
        self.assertEqual(self.clock, 0)

    def test_missing_service_inspection_is_not_success(self):
        self.states = [subprocess.TimeoutExpired('systemctl', 2)]
        with self.assertRaisesRegex(RuntimeError, 'inspection failed'):
            fp.wait_ready(CFG)
        self.assertEqual(self.receipt()['result'], 'FAIL')

    def test_tls_failure_after_readiness_keeps_https_and_startup_evidence(self):
        error = subprocess.CalledProcessError(60, ['curl'], output=b'do-not-save-session-body', stderr=b'certificate rejected')
        original = self.command
        def command(*args, **kwargs):
            if args[-1].startswith('https://'):
                self.assertNotIn('--insecure', args)
                self.assertNotIn('-k', args)
                raise error
            return original(*args, **kwargs)
        with patch.object(ops, 'run', side_effect=command), self.assertRaises(subprocess.CalledProcessError):
            fp.probe(CFG, True, True)
        folder = Path(self.receipt()['evidenceDirectory'])
        self.assertEqual(json.loads((folder / 'https-failure.json').read_text())['result'], 'FAIL')
        self.assertTrue((folder / 'https-journal.stdout').exists())
        self.assertFalse(any(b'do-not-save-session-body' in p.read_bytes() for p in folder.iterdir()))

    def test_version_failure_after_readiness_is_not_swallowed(self):
        original = self.command
        def command(*args, **kwargs):
            if args[-1].startswith('https://'):
                return subprocess.CompletedProcess(args, 0, b'wrong-version\n200')
            return original(*args, **kwargs)
        with patch.object(ops, 'run', side_effect=command), self.assertRaisesRegex(RuntimeError, 'version mismatch'):
            fp.probe(CFG, True, False)
        self.assertTrue((Path(self.receipt()['evidenceDirectory']) / 'https-failure.json').exists())

    def test_public_probe_remains_original_https_only(self):
        with patch.object(fp, 'wait_ready') as wait, patch.object(fp, 'https_probe') as https:
            fp.probe(CFG, False, False)
        wait.assert_not_called()
        https.assert_called_once_with(CFG, False, False)


if __name__ == '__main__':
    unittest.main()
