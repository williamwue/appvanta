"""Exercise cancellation of the official downloader against a stalled local HTTP fixture."""
import json
import os
import subprocess
import sys
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from perfetto_cancellation import AnalysisControl, AnalysisCancelled, resolve_processor

root = Path('.appvanta/runs') / ('perfetto-initialization-' + str(time.time_ns() // 1000000))
root = root.resolve()
root.mkdir(parents=True)
entered, release = threading.Event(), threading.Event()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', '1024')
        self.end_headers()
        (root / 'http-entered').write_text('ready')
        entered.set()
        release.wait(20)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
fixture = root / 'fixture'
fixture.mkdir()
(fixture / 'sitecustomize.py').write_text('''import json, os, subprocess
from pathlib import Path
from perfetto.trace_processor.platform import PlatformDelegate
from perfetto.prebuilts.perfetto_prebuilts import download_or_get_cached
original = subprocess.Popen
def tracked(*args, **kwargs):
    process = original(*args, **kwargs)
    Path(os.environ['APPVANTA_RESOLVER_CHILD']).write_text(json.dumps({'pid':process.pid}))
    return process
subprocess.Popen = tracked
original_expanduser = os.path.expanduser
os.path.expanduser = lambda value: os.environ['APPVANTA_RESOLVER_CACHE'] if value == '~' else original_expanduser(value)
PlatformDelegate.get_shell_path = lambda self, bin_path, fetch_latest=False: download_or_get_cached('fixture.bin', os.environ['APPVANTA_RESOLVER_URL'], '0' * 64)
''', encoding='utf-8')
request = root / 'cancel.json'
control = AnalysisControl(request, root)
failures = []


def cancel_download():
    if not entered.wait(15):
        failures.append('Downloader never reached local server')
    request.write_text('{}', encoding='utf-8')


trigger = threading.Thread(target=cancel_download)
env = {'PYTHONPATH': str(fixture), 'APPVANTA_RESOLVER_CHILD': str(root / 'child.json'),
       'APPVANTA_RESOLVER_CACHE': str(root / 'cache'),
       'APPVANTA_RESOLVER_URL': 'http://127.0.0.1:' + str(server.server_port) + '/stalled'}
try:
    trigger.start()
    with patch.dict(os.environ, env):
        try:
            resolve_processor(control, None)
        except AnalysisCancelled:
            pass
        else:
            raise AssertionError('Expected initialization cancellation')
    trigger.join()
    assert not failures, failures
    result = control.finish()
    assert result['requested'] and result['resolverExited']
    child = json.loads((root / 'child.json').read_text())['pid']
    # The curl PID is from the fixture's real Popen, not inferred from a process name.
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, child)
        if handle:
            code = wintypes.DWORD()
            assert kernel.GetExitCodeProcess(handle, ctypes.byref(code))
            kernel.CloseHandle(handle)
            assert code.value != 259, 'Downloader child remains alive'
        else:
            assert ctypes.get_last_error() == 87, 'Cannot verify downloader process exit'
    else:
        proc = Path('/proc') / str(child) / 'stat'
        if proc.exists():
            assert proc.read_text().split(') ', 1)[1].startswith('Z '), 'Downloader child remains alive'
        else:
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError('Downloader child remains alive')
    assert not list((root / 'cache').rglob('fixture-*.bin')), 'Incomplete download became a cached executable'
    evidence = {'status': 'passed', 'scope': 'official-downloader-local-stall-cancellation', 'root': str(root),
                'cancellation': result, 'downloadPid': child, 'downloadStopped': True}
    (root / 'http-entered').unlink()
    (root / 'input.trace').write_bytes(b'initialization-only: never parsed')
    for client in ['sdk', 'mcp']:
        (root / 'http-entered').unlink(missing_ok=True)
        checked = subprocess.run(['node', 'scripts/verify-perfetto-initialization-client.mjs', str(root), sys.executable, client],
                                 env={**os.environ, **env}, capture_output=True, text=True, timeout=45)
        assert checked.returncode == 0, checked.stdout + checked.stderr
        evidence[client] = json.loads(checked.stdout)
    (root / 'verification.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence))
finally:
    request.write_text('{}', encoding='utf-8')
    release.set()
    trigger.join()
    control.finish()
    server.shutdown()
    server.server_close()
