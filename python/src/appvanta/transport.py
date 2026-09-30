"""Local transport whose shutdown owns the server, not persisted Flow workers."""
from contextlib import asynccontextmanager, suppress
import os
import subprocess

import anyio
from anyio.streams.text import TextReceiveStream
from mcp import StdioServerParameters
from mcp.shared.message import SessionMessage
from mcp import types


@asynccontextmanager
async def appvanta_stdio(parameters: StdioServerParameters):
    # The generic MCP Windows transport puts descendants in a kill-on-close
    # Job Object. AppVanta's detached, persisted workers deliberately outlive it.
    process = await anyio.open_process(
        [parameters.command, *parameters.args], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=None, cwd=parameters.cwd, env=parameters.env,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        start_new_session=os.name != 'nt')
    incoming_send, incoming_receive = anyio.create_memory_object_stream(0)
    outgoing_send, outgoing_receive = anyio.create_memory_object_stream(0)
    writer_done = anyio.Event()

    async def read():
        try:
            async with incoming_send:
                buffer = ''
                async for chunk in TextReceiveStream(process.stdout, encoding='utf-8'):
                    lines = (buffer + chunk).split('\n')
                    buffer = lines.pop()
                    for line in lines:
                        if not line.strip():
                            continue
                        try:
                            message = SessionMessage(types.jsonrpc_message_adapter.validate_json(line, by_name=False))
                        except ValueError as error:
                            message = error
                        await incoming_send.send(message)
                if buffer.strip():
                    await incoming_send.send(ValueError('Server closed with an incomplete JSON-RPC line'))
        except (anyio.ClosedResourceError, anyio.BrokenResourceError):
            pass

    async def write():
        try:
            async with outgoing_receive:
                async for message in outgoing_receive:
                    data = message.message.model_dump_json(by_alias=True, exclude_unset=True)
                    await process.stdin.send((data + '\n').encode('utf-8'))
        except (anyio.ClosedResourceError, anyio.BrokenResourceError, OSError):
            await incoming_send.aclose()
        finally:
            writer_done.set()

    async with anyio.create_task_group() as group:
        group.start_soon(read)
        group.start_soon(write)
        try:
            yield incoming_receive, outgoing_send
        finally:
            with anyio.CancelScope(shield=True):
                await outgoing_send.aclose()
                with anyio.move_on_after(0.5):
                    await writer_done.wait()
                with suppress(anyio.BrokenResourceError, anyio.ClosedResourceError, OSError):
                    await process.stdin.aclose()
                with anyio.move_on_after(2):
                    await process.wait()
                if process.returncode is None:
                    with suppress(ProcessLookupError):
                        process.terminate()
                    with anyio.move_on_after(2):
                        await process.wait()
                if process.returncode is None:
                    with suppress(ProcessLookupError):
                        process.kill()
                    with anyio.fail_after(5):
                        await process.wait()
                await incoming_receive.aclose()
                await process.aclose()
                group.cancel_scope.cancel()
