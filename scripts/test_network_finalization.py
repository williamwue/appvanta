import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock
from network_finalization import finalize


class FinalizationTest(unittest.TestCase):
    def test_broken_log_preserves_original_and_summary(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'requests.jsonl'
            raw = b'{"id":"ok"}\n{"partial":\n\xff\n[]\n'
            output.write_bytes(raw)
            result = finalize(None, output, {'status': 'captured', 'proxyRestored': True})
            self.assertEqual(result['requests'], 1)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['cleanupErrors'][0]['lines'], [2, 3, 4])
            self.assertEqual(output.read_bytes(), raw)
            self.assertEqual(json.loads(output.with_name('summary.json').read_text()), result)

    def test_forced_termination_and_stop_error_still_write_summary(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'requests.jsonl'
            output.write_text('{}\n')
            process = Mock()
            process.poll.side_effect = [None, -9]
            process.wait.side_effect = [subprocess.TimeoutExpired('proxy', 10), -9]
            result = finalize(process, output, {'status': 'captured'})
            process.kill.assert_called_once()
            self.assertTrue(result['proxyStopped'])
            self.assertTrue(result['forcedTermination'])
            self.assertEqual(result['status'], 'failed')
            process = Mock()
            process.poll.return_value = None
            process.terminate.side_effect = OSError('stop failed')
            result = finalize(process, output, {'status': 'failed', 'restoreError': 'offline'})
            self.assertEqual(result['restoreError'], 'offline')
            self.assertFalse(result['proxyStopped'])
            self.assertEqual(result['requests'], 1)
            self.assertTrue(output.with_name('summary.json').exists())

    def test_missing_log_and_clean_stop(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / 'requests.jsonl'
            self.assertEqual(finalize(None, output, {'status': 'captured'})['status'], 'failed')
            output.write_text('{}\n')
            process = Mock()
            process.poll.side_effect = [None, 0]
            result = finalize(process, output, {'status': 'captured'})
            process.terminate.assert_called_once()
            self.assertEqual(result['status'], 'captured')
            self.assertEqual(result['cleanupErrors'], [])


if __name__ == '__main__':
    unittest.main()
