"""Installed Python SDK against the real local Node MCP server."""
import argparse
import asyncio
from importlib.metadata import version
import json
from pathlib import Path
import time

from appvanta import AppVanta, AppVantaToolError


async def wait_task(app, task_id, predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = await app.call('get_task', {'taskId': task_id}, timeout=5)
        if predicate(task):
            return task
        await asyncio.sleep(0.1)
    raise AssertionError(f'Task {task_id} did not reach the required state')


async def verify(device):
    root = Path('.appvanta/runs') / f'python-sdk-{time.time_ns()}'
    root.mkdir(parents=True, exist_ok=False)
    report = {'status': 'failed', 'pythonSdkVersion': version('appvanta'), 'mcpVersion': version('mcp')}
    task_id = None
    try:
        async with AppVanta.connect('packages/mcp/dist/index.js') as app:
            report['serverVersion'] = app.server_version
            tools = await app.tools()
            names = {tool.name for tool in tools}
            assert {'list_devices', 'run_flow', 'get_task', 'analyze_perfetto'} <= names
            report['tools'] = sorted(names)
            missing = 'task-00000000-0000-0000-0000-000000000000'
            try:
                await app.get_task(missing)
                raise AssertionError('Missing task must report a tool failure')
            except AppVantaToolError as error:
                assert error.tool == 'get_task' and error.result.is_error
                report['toolFailure'] = error.result.model_dump(mode='json', by_alias=True)
            assert {tool.name for tool in await app.tools()} == names
            report['sessionUsableAfterToolFailure'] = True
            if device:
                devices = await app.list_devices()
                assert any(item['id'] == device and item['status'] == 'online' for item in devices)
                observation = await app.observe(device)
                for key in ('screenshotPath', 'uiTreePath'):
                    assert Path(observation[key]).is_file()
                report.update(device=device, observation=observation)
                flow = {'version': 1, 'name': 'Python SDK read-only Flow',
                        'steps': [{'description': 'Retain Python caller marker', 'echo': root.name}]}
                run = await app.run_flow(device, flow)
                assert run['status'] == 'passed' and run['cleanupFailed'] is False
                run_dir = Path(run['runDirectory'])
                assert json.loads((run_dir / 'flow.json').read_text(encoding='utf-8')) == flow
                assert json.loads((run_dir / 'run.json').read_text(encoding='utf-8'))['status'] == 'passed'
                report['synchronousFlow'] = run
                waiting = {'version': 1, 'name': 'Python independent task disconnect and cancel',
                           'steps': [{'description': 'Wait for unique absent package', 'action': {
                               'kind': 'wait', 'condition': {'kind': 'app-running',
                               'packageName': f'dev.appvanta.absent.t{time.time_ns()}'}, 'timeoutMs': 60000}}]}
                started = await app.start_flow(device, waiting)
                task_id = started['taskId']
                report['startedTask'] = started
                report['runningBeforeDisconnect'] = await wait_task(app, task_id,
                    lambda task: task['status'] == 'running' and bool(task.get('runDirectory')))
        report['contextExited'] = True
        if task_id:
            async with AppVanta.connect('packages/mcp/dist/index.js') as observer:
                running = await observer.get_task(task_id)
                assert running['status'] == 'running', 'Independent worker must survive SDK context exit'
                assert running['runDirectory'] == report['runningBeforeDisconnect']['runDirectory']
                report['runningAfterDisconnect'] = running
                began = time.monotonic()
                cancelling = await observer.cancel_task(task_id)
                assert cancelling['status'] in ('cancelling', 'cancelled')
                completed = await wait_task(observer, task_id,
                    lambda task: task['status'] in ('passed', 'failed', 'cancelled', 'interrupted'), timeout=10)
                assert completed['status'] == 'cancelled'
                assert time.monotonic()-began < 10
                journal = json.loads((Path(completed['runDirectory']) / 'run.json').read_text(encoding='utf-8'))
                assert journal['status'] == 'cancelled'
                report.update(completedTask=completed, taskCancellationMs=round((time.monotonic()-began)*1000))
            async with AppVanta.connect('packages/mcp/dist/index.js') as reader:
                assert await reader.get_task(task_id) == completed
                report['terminalRecordPersistsAcrossReconnect'] = True
        report['status'] = 'passed'
    finally:
        if task_id and 'completedTask' not in report:
            try:
                async with AppVanta.connect('packages/mcp/dist/index.js') as cleanup:
                    await cleanup.cancel_task(task_id)
                    report['fixtureCleanup'] = await wait_task(cleanup, task_id,
                        lambda task: task['status'] in ('passed', 'failed', 'cancelled', 'interrupted'))
            except Exception as error:
                report['fixtureCleanupError'] = str(error)
        (root / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': report['status'], 'root': str(root)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--device')
    args = parser.parse_args()
    asyncio.run(verify(args.device))
