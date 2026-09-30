"""Exercise cancellation of an outstanding SQL request against real Trace Processor."""
import argparse
import json
from pathlib import Path
import threading
import time

from perfetto.trace_processor import TraceProcessorConfig
from perfetto_cancellation import AnalysisControl, controlled_processor


def verify(trace, output, trigger):
    output.mkdir(parents=True, exist_ok=False)
    cancel_file = output / 'cancel.request'
    control = AnalysisControl(cancel_file, output)
    evidence = {'status': 'failed', 'trigger': trigger,
                'scope': 'Outstanding synthetic SQL on real retained trace and owned processor'}
    thread = None
    try:
        with controlled_processor(control, trace, TraceProcessorConfig()) as processor:
            started, done = threading.Event(), threading.Event()
            result = {}
            sql = ('WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL '
                   'SELECT n+1 FROM numbers WHERE n<1000000000) SELECT SUM(n) AS total FROM numbers')

            def query():
                started.set()
                try:
                    result['rows'] = [row.__dict__ for row in processor.query(sql)]
                except Exception as error:
                    result['error'] = str(error)
                finally:
                    done.set()

            thread = threading.Thread(target=query, daemon=True)
            thread.start()
            assert started.wait(5), 'Query thread did not start'
            assert not done.wait(0.25), 'SQL returned before interruption window'
            assert control.process.poll() is None, 'Processor must be live before interruption'
            evidence.update(sql=sql, processorPid=control.process.pid, requestOutstanding=True)
            began = time.monotonic()
            if trigger == 'cancel-file':
                cancel_file.write_text('{}', encoding='utf-8')
            else:
                # Advance the real controller deadline, without waiting its normal 110 seconds.
                control.deadline = time.monotonic()
            assert done.wait(5), 'Outstanding query did not unblock within five seconds'
            thread.join()
            evidence.update(elapsedMs=round((time.monotonic()-began)*1000), query=result)
            assert 'error' in result and 'rows' not in result, 'Interrupted query must fail'
        cleanup = control.finish()
        evidence['cleanup'] = cleanup
        assert cleanup['requested'] is True
        assert cleanup['processorExited'] is True and cleanup['resolverExited'] is True
        assert cleanup['cleanupError'] is None
        evidence['status'] = 'passed'
    except Exception as error:
        evidence['error'] = str(error)
        raise
    finally:
        evidence['finalCleanup'] = control.finish()
        if thread is not None:
            thread.join(timeout=5)
            evidence['queryThreadExited'] = not thread.is_alive()
        (output / 'verification.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--trace', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    results = [verify(Path(args.trace).resolve(strict=True), Path(args.output) / trigger, trigger)
               for trigger in ('cancel-file', 'deadline')]
    print(json.dumps({'status': 'passed', 'results': results}))
