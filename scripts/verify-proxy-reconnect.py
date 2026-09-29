"""Exercise packaged proxy recovery with real ADB and injected transport failures."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--runtime', required=True)
args = parser.parse_args()
root = Path(args.output)
sys.path.insert(0, str(Path(args.runtime).resolve()))
from proxy_recovery import restore_proxy


def adb(*values, timeout=20):
    return subprocess.check_output(['adb', '-s', args.device, *values], text=True, timeout=timeout).strip()


original = adb('shell', 'settings', 'get', 'global', 'http_proxy')
session = '127.0.0.1:18889'
if original == session:
    raise RuntimeError('Test proxy matches original; choose an isolated emulator')
(root / 'original-proxy.json').write_text(json.dumps({'device': args.device, 'original': original, 'session': session}), encoding='utf-8')
report = {'status': 'running', 'device': args.device, 'original': original, 'scenarios': []}
try:
    for mode in ['repeat-disconnect', 'deadline']:
        adb('shell', 'settings', 'put', 'global', 'http_proxy', session)
        assert adb('shell', 'settings', 'get', 'global', 'http_proxy') == session
        calls = []
        def transport(*values, timeout):
            injected = mode == 'deadline' or len(calls) in [0, 3]
            calls.append({'args': values, 'timeout': timeout, 'injectedFailure': injected})
            if injected:
                raise subprocess.CalledProcessError(1, 'adb', stderr='injected transport offline')
            return adb(*values, timeout=timeout)
        journal = root / f'{mode}.jsonl'
        started = time.monotonic()
        if mode == 'deadline':
            try:
                restore_proxy(transport, original, session, journal, seconds=1)
                raise AssertionError('Offline restoration reported success')
            except RuntimeError as error:
                failure = str(error)
            elapsed = time.monotonic() - started
            assert elapsed < 3, elapsed
            assert all(call['injectedFailure'] for call in calls)
            assert adb('shell', 'settings', 'get', 'global', 'http_proxy') == session
            records = [json.loads(line) for line in journal.read_text().splitlines()]
            assert records and all(item['status'] == 'retry' for item in records)
            attempts = restore_proxy(adb, original, session, root / 'after-reconnect.jsonl')
            assert attempts == 1
            report['scenarios'].append({'mode': mode, 'elapsed': elapsed, 'failure': failure, 'calls': calls, 'reconnected': True})
        else:
            attempts = restore_proxy(transport, original, session, journal)
            assert attempts == 3, attempts
            assert sum(call['args'][2] in ['put', 'delete'] for call in calls) == 1
            assert [json.loads(line)['status'] for line in journal.read_text().splitlines()] == ['retry', 'retry', 'restored']
            report['scenarios'].append({'mode': mode, 'attempts': attempts, 'calls': calls})
        assert adb('shell', 'settings', 'get', 'global', 'http_proxy') == original
    report['status'] = 'passed'
finally:
    # Preserve unrelated external changes; the production recovery function rejects them.
    restore_proxy(adb, original, session, root / 'final-cleanup.jsonl')
    report['proxyRestored'] = adb('shell', 'settings', 'get', 'global', 'http_proxy') == original
    (root / 'verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
