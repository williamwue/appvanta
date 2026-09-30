from pathlib import Path
import sys
import tempfile
import unittest

from mcp import StdioServerParameters, types
from mcp.shared.message import SessionMessage
from appvanta.transport import appvanta_stdio


SERVER = '''import json,sys
from pathlib import Path
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps({'jsonrpc':'2.0','method':'fixture/ready'}),flush=True)
for line in sys.stdin:
    print(json.dumps({'jsonrpc':'2.0','method':'fixture/echo','params':json.loads(line)}),flush=True)
Path(sys.argv[1]).write_text('stdin closed',encoding='utf-8')
'''


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_roundtrip_and_graceful_owned_server_shutdown(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'closed.txt'
            parameters = StdioServerParameters(command=sys.executable, args=['-u', '-c', SERVER, str(marker)])
            async with appvanta_stdio(parameters) as (incoming, outgoing):
                self.assertEqual((await incoming.receive()).message.method, 'fixture/ready')
                await outgoing.send(SessionMessage(types.JSONRPCNotification(jsonrpc='2.0', method='ping', params={'value': '中文'})))
                received = await incoming.receive()
                self.assertIsInstance(received, SessionMessage, str(received))
                echoed = received.message
                self.assertEqual(echoed.params['params']['value'], '中文')
            self.assertEqual(marker.read_text(encoding='utf-8'), 'stdin closed')

    async def test_consumer_failure_still_closes_server_stdin(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'closed.txt'
            parameters = StdioServerParameters(command=sys.executable, args=['-u', '-c', SERVER, str(marker)])
            with self.assertRaises(ExceptionGroup):
                async with appvanta_stdio(parameters) as (incoming, _):
                    await incoming.receive()
                    raise ValueError('Injected caller failure')
            self.assertEqual(marker.read_text(encoding='utf-8'), 'stdin closed')


if __name__ == '__main__':
    unittest.main()
