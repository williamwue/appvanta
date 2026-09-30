"""Cooperative cancellation for one owned Trace Processor analysis."""
import json
import os
from pathlib import Path
import threading
import time


class AnalysisCancelled(Exception):
    pass


class AnalysisControl:
    def __init__(self, cancel_file, output):
        self.cancel_file = Path(cancel_file) if cancel_file else None
        self.output = Path(output)
        self.cancelled = threading.Event()
        self.stopped = threading.Event()
        self.processor = None
        self.process = None
        self.cleanup_error = None
        self.deadline = time.monotonic() + 110
        self.monitor = threading.Thread(target=self._monitor, daemon=True)
        self.monitor.start()

    def requested(self):
        return self.cancelled.is_set() or bool(self.cancel_file and self.cancel_file.exists()) or time.monotonic() >= self.deadline

    def check(self):
        if self.requested():
            self.cancelled.set()
            raise AnalysisCancelled('Perfetto analysis cancelled or analysis deadline reached')

    def _monitor(self):
        while not self.stopped.wait(0.025):
            if self.requested():
                self.cancelled.set()
                # The constructor may still be downloading or starting its server.
                # Wait until its public HTTP client and owned resources exist.
                if self.processor is not None and hasattr(self.processor, 'http'):
                    try:
                        self.process = self.process or getattr(self.processor, 'subprocess', None)
                        self.processor.close()
                    except Exception as error:
                        self.cleanup_error = str(error)
                    return

    def chunks(self, trace):
        self.check()
        self.process = self.processor.subprocess
        (self.output / 'processor.json').write_text(json.dumps({'version': 1, 'pid': self.process.pid, 'analysisPid': os.getpid(), 'phase': 'loading-trace'}), encoding='utf-8')
        with Path(trace).open('rb') as source:
            while True:
                self.check()
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk
        self.check()

    def finish(self):
        self.stopped.set()
        self.monitor.join()
        if self.processor is not None:
            self.process = self.process or getattr(self.processor, 'subprocess', None)
            try:
                self.processor.close()
            except Exception as error:
                self.cleanup_error = str(error)
        if self.requested():
            self.cancelled.set()
        return {'requested': self.cancelled.is_set(), 'processorPid': self.process.pid if self.process else None,
                'processorExited': self.process.poll() is not None if self.process else None,
                'cleanupError': self.cleanup_error}


def controlled_processor(control, trace, config):
    from perfetto.trace_processor import TraceProcessor

    class OwnedProcessor(TraceProcessor):
        def __init__(self):
            self.close_lock = threading.RLock()
            control.processor = self
            try:
                super().__init__(trace=control.chunks(trace), config=config)
                control.check()
            except BaseException:
                self.close()
                raise

        def close(self):
            with self.close_lock:
                super().close()

    return OwnedProcessor()
