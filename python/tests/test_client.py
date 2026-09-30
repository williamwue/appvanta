import unittest
from unittest.mock import AsyncMock

from mcp.types import CallToolResult, TextContent
from appvanta import AppVanta, AppVantaResultError, AppVantaToolError


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_failure_keeps_raw_result_without_retry(self):
        result = CallToolResult(isError=True, content=[TextContent(type='text', text='{"error":"failed"}')])
        transport = AsyncMock()
        transport.call_tool.return_value = result
        app = AppVanta(transport)
        with self.assertRaises(AppVantaToolError) as raised:
            await app.call('execute_action', {'deviceId': 'test'})
        self.assertIs(raised.exception.result, result)
        self.assertEqual(raised.exception.tool, 'execute_action')
        transport.call_tool.assert_awaited_once()

    async def test_json_values_remain_values(self):
        transport = AsyncMock()
        app = AppVanta(transport)
        for text, value in [('null', None), ('false', False), ('[]', []), ('{"text":"中文"}', {'text': '中文'})]:
            transport.call_tool.return_value = CallToolResult(content=[TextContent(type='text', text=text)])
            self.assertEqual(await app.call('fixture'), value)

    async def test_mixed_content_is_not_silently_discarded(self):
        result = CallToolResult(content=[TextContent(type='text', text='{}'), TextContent(type='text', text='extra')])
        transport = AsyncMock()
        transport.call_tool.return_value = result
        app = AppVanta(transport)
        with self.assertRaises(AppVantaResultError):
            await app.call('fixture')
        self.assertIs(await app.call_raw('fixture'), result)

    async def test_invalid_timeout_does_not_dispatch(self):
        transport = AsyncMock()
        app = AppVanta(transport)
        for timeout in (0, -1, float('nan'), float('inf'), True):
            with self.assertRaises(ValueError):
                await app.call('execute_action', timeout=timeout)
        transport.call_tool.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
