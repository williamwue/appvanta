import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from proxy_recovery import restore_proxy


class RecoveryTest(unittest.TestCase):
    def test_transient_disconnect_reconnect(self):
        with tempfile.TemporaryDirectory() as root:
            journal = Path(root) / 'attempts.jsonl'
            calls = []
            responses = iter([subprocess.CalledProcessError(1, 'adb'), 'session:1234', '', ':0'])
            def adb(*args, timeout):
                calls.append(args)
                self.assertGreater(timeout, 0)
                value = next(responses)
                if isinstance(value, Exception):
                    raise value
                return value
            with patch('proxy_recovery.time.sleep'):
                self.assertEqual(restore_proxy(adb, ':0', 'session:1234', journal), 2)
            self.assertEqual(calls[2][-1], ':0')
            self.assertEqual([json.loads(line)['status'] for line in journal.read_text().splitlines()], ['retry', 'restored'])

    def test_conflict_does_not_write(self):
        with tempfile.TemporaryDirectory() as root:
            calls = []
            def adb(*args, timeout):
                calls.append(args)
                return 'other:9999'
            with self.assertRaisesRegex(RuntimeError, 'refusing'):
                restore_proxy(adb, ':0', 'session:1234', Path(root) / 'log')
            self.assertEqual(len(calls), 1)

    def test_deadline_and_already_restored(self):
        with tempfile.TemporaryDirectory() as root:
            def offline(*args, timeout):
                raise subprocess.TimeoutExpired('adb', timeout)
            with self.assertRaises(RuntimeError):
                restore_proxy(offline, ':0', 'session:1234', Path(root) / 'log', seconds=0)
            self.assertEqual(restore_proxy(lambda *args, **kw: ':0', ':0', 'session:1234', Path(root) / 'log'), 1)


if __name__ == '__main__':
    unittest.main()
