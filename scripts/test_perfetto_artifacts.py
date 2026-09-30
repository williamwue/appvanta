import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import json


spec = importlib.util.spec_from_file_location('perfetto_artifact_analyzer', Path(__file__).with_name('analyze-perfetto.py'))
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)


class AnalysisArtifactTests(unittest.TestCase):
    def test_success_preserves_metrics_and_report(self):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'input.trace'
            trace.write_bytes(b'fixture')
            output = Path(directory) / 'analysis'
            self.assertEqual(self.run_analysis(output, trace)['status'], 'passed')
            self.assertEqual(json.loads((output / 'metrics.json').read_text())['metrics']['cpu.scheduledTime']['value'], 10)
            self.assertTrue((output / 'report.md').is_file())

    def run_analysis(self, output, trace, fail_report=False, fail_cleanup=False):
        processor = MagicMock()
        processor.__enter__.return_value = processor
        processor.http.status.return_value = SimpleNamespace(human_readable_version='fixture')
        rows = [
            [{'start_ts': 0, 'end_ts': 6000000000}], [], [{'count': 1}],
            [{'upid': 1, 'pid': 1, 'name': 'dev.app'}],
            [{'pid': 1, 'tid': 1, 'name': 'main', 'scheduled_ns': 10, 'slices': 1}],
            [{'state_rows': 1, 'observed_ns': 5, 'completed_slices': 1, 'incomplete_slices': 0}],
            [{'str_value': 'fixture/model/device:version/build'}],
        ]
        processor.query.side_effect = [[SimpleNamespace(**row) for row in query] for query in rows]
        original_write = Path.write_text

        def write(path, *args, **kwargs):
            if fail_report and path.name == 'report.md':
                raise OSError('Injected report write failure')
            return original_write(path, *args, **kwargs)

        original_finish = analyzer.AnalysisControl.finish

        def finish(control):
            result = original_finish(control)
            if fail_cleanup:
                result.update(processorExited=False, cleanupError='Injected cleanup failure')
            return result

        with patch.object(analyzer, 'controlled_processor', return_value=processor), \
                patch.object(Path, 'write_text', write), \
                patch.object(analyzer.AnalysisControl, 'finish', finish):
            return analyzer.analyze(trace, 'dev.app', output, 'artifact-fixture', 6000)

    def test_failed_report_withholds_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'input.trace'
            trace.write_bytes(b'fixture')
            output = Path(directory) / 'analysis'
            with self.assertRaisesRegex(OSError, 'Injected report write failure'):
                self.run_analysis(output, trace, fail_report=True)
            self.assertEqual(json.loads((output / 'analysis.json').read_text())['status'], 'failed')
            self.assertFalse((output / 'metrics.json').exists())
            self.assertFalse((output / 'report.md').exists())

    def test_unverified_cleanup_withholds_both_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'input.trace'
            trace.write_bytes(b'fixture')
            output = Path(directory) / 'analysis'
            with self.assertRaisesRegex(RuntimeError, 'cleanup unverified'):
                self.run_analysis(output, trace, fail_cleanup=True)
            self.assertEqual(json.loads((output / 'analysis.json').read_text())['status'], 'failed')
            self.assertFalse((output / 'metrics.json').exists())
            self.assertFalse((output / 'report.md').exists())


if __name__ == '__main__':
    unittest.main()
