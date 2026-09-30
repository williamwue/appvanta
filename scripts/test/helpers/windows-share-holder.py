"""Hold a real Win32 file handle that permits read/write but denies deletion."""
import ctypes
from ctypes import wintypes
import json
import os
import sys
import time


def emit(phase):
    print(json.dumps({'phase': phase, 'pid': os.getpid(), 'at': round(time.time()*1000)}), flush=True)


if os.name != 'nt':
    raise SystemExit('Windows-only sharing fixture')
emit('process-started')
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.CloseHandle.restype = wintypes.BOOL
handle = kernel.CreateFileW(os.environ['APPVANTA_RECORD'], 0x80000000, 0x1 | 0x2, None, 3, 0x80, None)
if handle == ctypes.c_void_p(-1).value:
    raise ctypes.WinError(ctypes.get_last_error())
try:
    emit('lock-acquired')
    sys.stdin.readline()
finally:
    if not kernel.CloseHandle(handle):
        raise ctypes.WinError(ctypes.get_last_error())
    emit('lock-released')
