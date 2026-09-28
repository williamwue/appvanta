"""Bounded proxy restoration; never replace an unrelated current setting."""
import json
import subprocess
import time


def restore_proxy(adb, original, session, journal, seconds=60):
    deadline = time.monotonic() + seconds
    attempts = 0
    while True:
        attempts += 1
        def call(*args):
            return adb(*args, timeout=min(20, max(0.1, deadline - time.monotonic())))
        try:
            current = call('shell', 'settings', 'get', 'global', 'http_proxy')
            if current != original:
                if current != session:
                    raise ValueError('Proxy changed outside this session; refusing to overwrite it')
                if original == 'null':
                    call('shell', 'settings', 'delete', 'global', 'http_proxy')
                else:
                    call('shell', 'settings', 'put', 'global', 'http_proxy', original)
                if call('shell', 'settings', 'get', 'global', 'http_proxy') != original:
                    raise ValueError('Proxy restoration readback mismatch')
            event = {'attempt': attempts, 'status': 'restored'}
        except (subprocess.SubprocessError, OSError) as error:
            event = {'attempt': attempts, 'status': 'retry', 'error': str(error)}
        except ValueError as error:
            event = {'attempt': attempts, 'status': 'conflict', 'error': str(error)}
        with journal.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(event) + '\n')
        if event['status'] == 'restored':
            return attempts
        if event['status'] == 'conflict' or time.monotonic() >= deadline:
            raise RuntimeError(event['error'])
        time.sleep(min(1, max(0, deadline - time.monotonic())))
