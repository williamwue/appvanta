"""Cooperative cancellation for one owned Trace Processor analysis."""
import json
import os
from pathlib import Path
import subprocess
import sys
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
        self.resolver = None
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
                'resolverPid': self.resolver.pid if self.resolver else None,
                'resolverExited': self.resolver.poll() is not None if self.resolver else None,
                'cleanupError': self.cleanup_error}


def resolve_processor(control, bin_path):
    from perfetto.trace_processor.process_tree import create_kill_on_close_job, terminate_process_tree
    control.check()
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0
    worker = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--resolve', bin_path or ''],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, encoding='utf-8', creationflags=flags, start_new_session=os.name != 'nt')
    control.resolver = worker
    job = create_kill_on_close_job(worker)
    evidence = {'version': 1, 'phase': 'resolving-tool', 'pid': worker.pid, 'analysisPid': os.getpid()}
    try:
        if os.name == 'nt' and job is None:
            raise RuntimeError('Cannot own Perfetto resolver process tree')
        (control.output / 'initialization.json').write_text(json.dumps(evidence), encoding='utf-8')
        worker.stdin.write('resolve\n')
        worker.stdin.close()
        worker.stdin = None
        while True:
            control.check()
            try:
                stdout, stderr = worker.communicate(timeout=0.05)
                break
            except subprocess.TimeoutExpired:
                continue
        control.check()
        if worker.returncode != 0:
            raise RuntimeError('Perfetto tool resolution failed: ' + stderr[-4096:])
        path = json.loads(stdout)
        if not isinstance(path, str) or not Path(path).is_file():
            raise RuntimeError('Perfetto resolver returned an invalid executable path')
        return path
    finally:
        terminate_process_tree(worker, job)
        worker.communicate()
        evidence.update(exited=worker.poll() is not None, returnCode=worker.returncode,
                        cancelled=control.requested())
        (control.output / 'initialization.json').write_text(json.dumps(evidence), encoding='utf-8')


def controlled_processor(control, trace, config):
    from perfetto.trace_processor import TraceProcessor
    config.bin_path = resolve_processor(control, config.bin_path)
    control.check()

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


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--resolve':
        raise SystemExit('Expected --resolve <optional binary path>')
    if sys.stdin.readline() != 'resolve\n':
        raise SystemExit('Resolver ownership handshake missing')
    import contextlib
    from perfetto.trace_processor.platform import PlatformDelegate
    with contextlib.redirect_stdout(sys.stderr):
        resolved = PlatformDelegate().get_shell_path(sys.argv[2] or None)
    print(json.dumps(resolved))
