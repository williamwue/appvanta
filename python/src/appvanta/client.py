from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
import json
import math
import os
from pathlib import Path
from typing import Any

from mcp import Client, StdioServerParameters
from mcp.types import CallToolResult, TextContent, Tool
from .transport import appvanta_stdio


class AppVantaToolError(RuntimeError):
    """A tool failed; the complete MCP result remains available as result."""

    def __init__(self, tool: str, result: CallToolResult):
        self.tool, self.result = tool, result
        detail = '\n'.join(block.text for block in result.content if isinstance(block, TextContent))
        super().__init__(f'{tool}: {detail or "Tool failed"}')


class AppVantaResultError(ValueError):
    """A successful response was not the expected single JSON value."""

    def __init__(self, tool: str, result: CallToolResult):
        self.tool, self.result = tool, result
        super().__init__(f'{tool}: expected structured data or one JSON text block; inspect result')


def _decode(tool: str, result: CallToolResult) -> Any:
    if result.is_error:
        raise AppVantaToolError(tool, result)
    if result.structured_content is not None:
        return result.structured_content
    if len(result.content) == 1 and isinstance(result.content[0], TextContent):
        try:
            return json.loads(result.content[0].text)
        except json.JSONDecodeError as error:
            raise AppVantaResultError(tool, result) from error
    raise AppVantaResultError(tool, result)


class AppVanta:
    """One local MCP connection. Calls execute once, without automatic retries."""

    def __init__(self, client: Client):
        self._client = client

    @classmethod
    @asynccontextmanager
    async def connect(cls, server_script: str | Path, *, node: str = 'node',
                      cwd: str | Path | None = None,
                      env: Mapping[str, str] | None = None) -> AsyncIterator['AppVanta']:
        """Launch an installed server using Node; enter and exit in the same task."""
        script = Path(server_script).resolve(strict=True)
        if not script.is_file():
            raise ValueError('server_script must be a file')
        parameters = StdioServerParameters(command=node, args=[str(script)],
                                           cwd=Path(cwd).resolve(strict=True) if cwd is not None else None,
                                           env={**os.environ, **(env or {})})
        async with Client(appvanta_stdio(parameters), mode='legacy', cache=None) as client:
            if client.server_info is None or client.server_info.name != 'appvanta':
                raise RuntimeError('The selected script did not identify as AppVanta')
            yield cls(client)

    @property
    def server_version(self) -> str:
        return self._client.server_info.version

    async def tools(self) -> list[Tool]:
        """Return current server tool definitions and their input schemas."""
        return (await self._client.list_tools()).tools

    async def call_raw(self, name: str, arguments: Mapping[str, Any] | None = None,
                       *, timeout: float | None = None) -> CallToolResult:
        """Return the full MCP result, including is_error and content blocks.

        Timeout/caller cancellation abandons the request through MCP. It does
        not establish that a device action was undone or that cleanup finished.
        """
        if not isinstance(name, str) or not name:
            raise ValueError('Tool name must be nonempty')
        if timeout is not None and (isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0):
            raise ValueError('timeout must be a positive finite number')
        return await self._client.call_tool(name, dict(arguments or {}), read_timeout_seconds=timeout)

    async def call(self, name: str, arguments: Mapping[str, Any] | None = None,
                   *, timeout: float | None = None) -> Any:
        """Decode a successful JSON result; raise AppVantaToolError on tool failure."""
        return _decode(name, await self.call_raw(name, arguments, timeout=timeout))

    async def list_devices(self) -> Any:
        return await self.call('list_devices')

    async def observe(self, device_id: str) -> Any:
        return await self.call('observe_app', {'deviceId': device_id})

    async def execute_action(self, device_id: str, action: Mapping[str, Any]) -> Any:
        return await self.call('execute_action', {'deviceId': device_id, 'action': dict(action)})

    async def run_flow(self, device_id: str, flow: Mapping[str, Any]) -> Any:
        return await self.call('run_flow', {'deviceId': device_id, 'flow': dict(flow)})

    async def start_flow(self, device_id: str, flow: Mapping[str, Any]) -> Any:
        return await self.call('start_flow', {'deviceId': device_id, 'flow': dict(flow)})

    async def get_task(self, task_id: str) -> Any:
        return await self.call('get_task', {'taskId': task_id})

    async def cancel_task(self, task_id: str) -> Any:
        return await self.call('cancel_task', {'taskId': task_id})
