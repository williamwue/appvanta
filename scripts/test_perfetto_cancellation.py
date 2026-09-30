import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from perfetto_cancellation import AnalysisControl


class FinalizationCancellationTests(unittest.TestCase):
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
