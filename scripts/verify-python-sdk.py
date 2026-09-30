"""Installed Python SDK against the real local Node MCP server."""
import argparse
import asyncio
from importlib.metadata import version
import json
from pathlib import Path
import time

from appvanta import AppVanta, AppVantaToolError


async def verify(device):
    root = Path('.appvanta/runs') / f'python-sdk-{time.time_ns()}'
    root.mkdir(parents=True, exist_ok=False)
    report = {'status': 'failed', 'pythonSdkVersion': version('appvanta'), 'mcpVersion': version('mcp')}
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
            report['status'] = 'passed'
        report['contextExited'] = True
    finally:
        (root / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': report['status'], 'root': str(root)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--device')
    args = parser.parse_args()
    asyncio.run(verify(args.device))
