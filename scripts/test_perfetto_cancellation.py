import tempfile
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from perfetto_cancellation import AnalysisControl


class FinalizationCancellationTests(unittest.TestCase):
    def test_owner_pipe_eof_requests_cancellation(self):
        code = ('import json,time; from perfetto_cancellation import AnalysisControl; '
                'c=AnalysisControl(None,".",owner_stdin=True); '
                'c.cancelled.wait(2); print(json.dumps(c.finish()))')
        result = subprocess.run([sys.executable, '-c', code], input='', capture_output=True,
                                text=True, timeout=5, check=True)
        evidence = json.loads(result.stdout)
        self.assertTrue(evidence['requested'])
        self.assertTrue(evidence['ownerDisconnected'])

    def test_live_owner_pipe_does_not_prevent_normal_exit(self):
        code = ('import json,time; from perfetto_cancellation import AnalysisControl; '
                'c=AnalysisControl(None,".",owner_stdin=True); '
                'time.sleep(0.1); print(json.dumps(c.finish()))')
        with subprocess.Popen([sys.executable, '-c', code], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as child:
            try:
                self.assertEqual(child.wait(timeout=5), 0)
                evidence = json.loads(child.stdout.read())
                self.assertFalse(evidence['requested'])
                self.assertFalse(evidence['ownerDisconnected'])
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()

    def test_request_before_finish_is_recorded_without_monitor_tick(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / 'cancel.json'
            # Freeze the polling thread to reproduce a request between ticks.
            with patch('perfetto_cancellation.threading.Thread.start'), patch('perfetto_cancellation.threading.Thread.join'):
                control = AnalysisControl(request, directory)
                request.write_text('{}', encoding='utf-8')
                self.assertTrue(control.finish()['requested'])

    def test_deadline_before_finish_is_recorded_without_monitor_tick(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('perfetto_cancellation.threading.Thread.start'), patch('perfetto_cancellation.threading.Thread.join'):
                control = AnalysisControl(None, directory)
                control.deadline = 0
                self.assertTrue(control.finish()['requested'])

    def test_normal_finish_is_not_cancelled(self):
        with tempfile.TemporaryDirectory() as directory:
            control = AnalysisControl(None, directory)
            self.assertFalse(control.finish()['requested'])

    def test_request_during_processor_close_is_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / 'cancel.json'
            control = AnalysisControl(request, directory)
            control.processor = SimpleNamespace(close=lambda: request.write_text('{}', encoding='utf-8'))
            self.assertTrue(control.finish()['requested'])


if __name__ == '__main__':
    unittest.main()
