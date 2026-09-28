"""Run a bounded mitmproxy session and restore the Android proxy on exit."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import proxy_recovery as recovery
from network_finalization import finalize


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mitmdump', required=True)
    parser.add_argument('--device', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--seconds', type=int, default=30)
    parser.add_argument('--port', type=int, default=18080)
    parser.add_argument('--device-host', default='10.0.2.2')
    parser.add_argument('--open-url', help='Optional Android browser URL for a test request')
    parser.add_argument('--map-remote', help='Optional mitmproxy URL mapping for local test fixtures')
    parser.add_argument('--ca-dir', default='.appvanta/network-ca', help='Private CA directory; keep outside exported evidence')
    parser.add_argument('--upstream-ca', help='Optional PEM CA bundle for a private TLS test server')
    parser.add_argument('--controlled', action='store_true', help='Signal readiness and stop when stop.request exists')
    parser.add_argument('--owner-stdin', action='store_true', help='Restore proxy when the owning process closes stdin')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 3600 or not 1024 <= args.port <= 65535:
        parser.error('seconds must be 1..3600 and port 1024..65535')
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=False)
    output = root / 'requests.jsonl'
    output.touch()
    def adb(*values, timeout=20):
        return subprocess.check_output(['adb', '-s', args.device, *values], text=True, timeout=timeout).strip()
    original = adb('shell', 'settings', 'get', 'global', 'http_proxy')
    env = dict(os.environ, APPVANTA_NETWORK_OUTPUT=str(output))
    process = None
    changed = False
    status = 'failed'
    owner_gone = threading.Event()
    if args.owner_stdin:
        def watch_owner():
            try:
                # Avoid holding Python's buffered-stdin lock during shutdown.
                while os.read(sys.stdin.fileno(), 1):
                    pass
            finally:
                owner_gone.set()
        threading.Thread(target=watch_owner, daemon=True).start()
    try:
        with (root / 'proxy.log').open('w', encoding='utf-8') as log:
            proxy_command = [
                args.mitmdump, '--listen-host', '127.0.0.1', '--listen-port', str(args.port),
                '--set', 'confdir=' + str(Path(args.ca_dir).resolve()), '-s', str(Path(__file__).with_name('network-addon.py')),
                '--set', 'connection_strategy=lazy', '--set', 'upstream_cert=false',
            ]
            if args.map_remote:
                proxy_command.extend(['--map-remote', args.map_remote])
            if args.upstream_ca:
                proxy_command.extend(['--set', 'ssl_verify_upstream_trusted_ca=' + str(Path(args.upstream_ca).resolve())])
            process = subprocess.Popen(proxy_command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env)
            deadline = time.monotonic() + 15
            while True:
                if owner_gone.is_set():
                    status = 'interrupted'
                    return
                if args.controlled and (root / 'stop.request').exists():
                    status = 'cancelled'
                    return
                if process.poll() is not None:
                    raise RuntimeError('Proxy exited; inspect proxy.log')
                if (root / 'proxy-ready.json').exists():
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError('Proxy startup timeout')
                time.sleep(0.2)
            # Persist every takeover coordinate before changing device state.
            (root / 'recovery.json').write_text(json.dumps({'version': 2, 'device': args.device, 'originalProxy': original, 'sessionProxy': f'{args.device_host}:{args.port}', 'workerPid': os.getpid(), 'proxyPid': process.pid, 'outputRoot': str(root), 'mitmdump': str(Path(args.mitmdump).resolve()), 'port': args.port}), encoding='utf-8')
            changed = True
            adb('shell', 'settings', 'put', 'global', 'http_proxy', f'{args.device_host}:{args.port}')
            actual = adb('shell', 'settings', 'get', 'global', 'http_proxy')
            if actual != f'{args.device_host}:{args.port}':
                raise RuntimeError('Android proxy setting did not take effect')
            (root / 'ready.json').write_text(json.dumps({'proxy': actual}), encoding='utf-8')
            if args.open_url:
                adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', args.open_url)
            end = time.monotonic() + args.seconds
            while time.monotonic() < end:
                if owner_gone.is_set():
                    status = 'interrupted'
                    return
                if process.poll() is not None:
                    raise RuntimeError('Proxy exited during capture')
                if args.controlled and (root / 'stop.request').exists():
                    break
                time.sleep(0.2)
            else:
                if args.controlled:
                    raise TimeoutError('Controlled capture reached its session deadline')
            status = 'captured'
    finally:
        restored = not changed
        restore_error = None
        try:
            if changed:
                recovery.restore_proxy(adb, original, f'{args.device_host}:{args.port}', root / 'restoration.jsonl')
                restored = True
        except Exception as error:
            restore_error = str(error)
            status = 'failed'
            raise
        finally:
            summary = finalize(process, output, {'status': status, 'device': args.device, 'output': str(output), 'originalProxy': original, 'proxyRestored': restored, 'restoreError': restore_error})
            print(json.dumps(summary))
            if summary['cleanupErrors'] and restore_error is None:
                raise RuntimeError('Network cleanup or request evidence failed; inspect summary.json')


if __name__ == '__main__':
    main()
