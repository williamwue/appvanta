"""Cancel an installed Python SDK request while real Perfetto input is loading."""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import subprocess
import time

from appvanta import AppVanta


def alive(pid):
    assert isinstance(pid, int) and pid > 0
    result = subprocess.run(['node', '-e',
        'try {process.kill(Number(process.argv[1]),0)} catch(e) {if(e.code==="ESRCH") process.exit(3); throw e}',
        str(pid)], capture_output=True, timeout=5)
    assert result.returncode in (0, 3), result.stderr.decode(errors='replace')
    return result.returncode == 0


async def verify(trace, python):
    root = Path('.appvanta/runs') / f'python-cancellation-{time.time_ns()}'
    root.mkdir(parents=True, exist_ok=False)
    data = trace.read_bytes()
    expanded = root / 'cancellation-input.trace'
    with expanded.open('wb') as output:
        for _ in range(256):
            output.write(data)
    report = {'status': 'failed', 'sourceSha256': hashlib.sha256(data).hexdigest(),
              'scope': 'Python caller cancellation during real processor loading of repeated trace fixture'}
    pending = None
    try:
        async with AppVanta.connect('packages/mcp/dist/index.js') as app:
            args = {'trace': str(trace.resolve()), 'packageName': 'dev.appvanta.performanceprobe',
                    'python': python, 'windowMs': 6000}
            report['normal'] = await app.call('analyze_perfetto', args)
            assert report['normal']['status'] == 'passed'
            before = set(Path('.appvanta/runs').glob('perfetto-analysis-*'))
            pending = asyncio.create_task(app.call('analyze_perfetto', {**args, 'trace': str(expanded.resolve())}))
            active = None
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                for directory in set(Path('.appvanta/runs').glob('perfetto-analysis-*')) - before:
                    if not directory.is_dir():
                        continue
                    try:
                        processor = json.loads((directory / 'processor.json').read_text(encoding='utf-8'))
                    except (FileNotFoundError, json.JSONDecodeError):
                        continue
                    if processor['phase'] == 'loading-trace':
                        active = directory
                        break
                if active:
                    break
                assert not pending.done(), 'Request finished before cancellation checkpoint'
                await asyncio.sleep(0.01)
            assert active, 'Loading checkpoint was not reached'
            assert alive(processor['pid']) and alive(processor['analysisPid'])
            report.update(directory=str(active), processor=processor)
            began = time.monotonic()
            pending.cancel()
            try:
                await pending
                raise AssertionError('Python call did not propagate caller cancellation')
            except asyncio.CancelledError:
                report['callerCancelled'] = True
            receipt = None
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    receipt = json.loads((active / 'analysis.json').read_text(encoding='utf-8'))
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                if receipt and not alive(processor['analysisPid']) and not alive(processor['pid']):
                    break
                await asyncio.sleep(0.02)
            report.update(elapsedMs=round((time.monotonic()-began)*1000), analysis=receipt)
            assert report['elapsedMs'] < 5000, 'Python request cleanup exceeded five seconds'
            assert receipt and receipt['status'] == 'cancelled'
            assert receipt['cancellation']['requested'] is True
            assert receipt['cancellation']['ownerDisconnected'] is False, 'Request cancellation must not require owner termination'
            assert receipt['cancellation']['cleanupError'] is None
            assert not alive(processor['analysisPid']) and not alive(processor['pid'])
            assert not (active / 'metrics.json').exists() and not (active / 'report.md').exists()
            assert any(tool.name == 'analyze_perfetto' for tool in await app.tools())
            report['sessionUsableAfterCancel'] = True
        report['status'] = 'passed'
    finally:
        if pending and not pending.done():
            pending.cancel()
            try:
                await pending
            except asyncio.CancelledError:
                pass
        (root / 'verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'status': report['status'], 'root': str(root)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--trace', required=True)
    parser.add_argument('--python', required=True)
    args = parser.parse_args()
    asyncio.run(verify(Path(args.trace).resolve(strict=True), args.python))
