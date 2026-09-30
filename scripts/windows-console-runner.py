"""Run one verification command in an isolated hidden console and deliver real Ctrl+C."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from perfetto.trace_processor.process_tree import create_kill_on_close_job, terminate_process_tree

if sys.platform != 'win32' or len(sys.argv) < 4:
    raise SystemExit('Usage on Windows: windows-console-runner.py <request-file> <executable> <args...>')
request = Path(sys.argv[1]).resolve()
receipt = Path(str(request) + '.json')
if request.exists() or receipt.exists():
    raise SystemExit('Console verification requires fresh request and receipt paths')
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.GetConsoleProcessList.argtypes = [ctypes.POINTER(ctypes.c_ulong), ctypes.c_ulong]
kernel.GetConsoleProcessList.restype = ctypes.c_ulong
kernel.AttachConsole.argtypes = [ctypes.c_ulong]
kernel.AttachConsole.restype = ctypes.c_int
kernel.SetConsoleCtrlHandler.argtypes = [ctypes.c_void_p, ctypes.c_int]
kernel.SetConsoleCtrlHandler.restype = ctypes.c_int
kernel.GenerateConsoleCtrlEvent.argtypes = [ctypes.c_ulong, ctypes.c_ulong]
kernel.GenerateConsoleCtrlEvent.restype = ctypes.c_int


def console_pids():
    buffer = (ctypes.c_ulong * 256)()
    count = kernel.GetConsoleProcessList(buffer, len(buffer))
    if count > len(buffer):
        raise RuntimeError('Unexpected console process count')
    return set(buffer[:count])


original = console_pids() - {os.getpid()}
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = subprocess.SW_HIDE
child = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NEW_CONSOLE,
                         startupinfo=startup)
job = None
evidence = {'version': 1, 'pid': child.pid, 'runnerPid': os.getpid(), 'event': 'CTRL_C_EVENT',
            'newConsole': True, 'hidden': True, 'sent': False}
try:
    job = create_kill_on_close_job(child)
    if job is None:
        raise RuntimeError('Cannot establish ownership of verification command')
    deadline = time.monotonic() + 150
    sent_at = None
    while True:
        if request.exists() and sent_at is None:
            if child.poll() is not None:
                raise RuntimeError('Command exited before console event')
            kernel.FreeConsole()
            if not kernel.AttachConsole(child.pid):
                raise ctypes.WinError(ctypes.get_last_error())
            if not kernel.SetConsoleCtrlHandler(None, True):
                raise ctypes.WinError(ctypes.get_last_error())
            members = console_pids()
            if child.pid not in members or os.getpid() not in members or original.intersection(members):
                raise RuntimeError('Console isolation could not be verified')
            evidence['consolePids'] = sorted(members)
            if not kernel.GenerateConsoleCtrlEvent(0, 0):
                raise ctypes.WinError(ctypes.get_last_error())
            evidence['sent'] = True
            sent_at = time.monotonic()
            deadline = min(deadline, sent_at + 30)
        if time.monotonic() > deadline:
            raise TimeoutError('Verification command did not exit within its deadline')
        try:
            stdout, stderr = child.communicate(timeout=0.02)
            break
        except subprocess.TimeoutExpired:
            pass
    evidence.update(exitCode=child.returncode, exited=True,
                    elapsedAfterSignalMs=None if sent_at is None else round((time.monotonic() - sent_at) * 1000))
    sys.stdout.buffer.write(stdout)
    sys.stderr.buffer.write(stderr)
finally:
    terminate_process_tree(child, job)
    evidence['exited'] = child.poll() is not None
    receipt.write_text(json.dumps(evidence, indent=2), encoding='utf-8')
    kernel.FreeConsole()
if not evidence['sent']:
    raise SystemExit('Command exited without receiving the requested console event')
sys.exit(child.returncode)
