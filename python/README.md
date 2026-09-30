# AppVanta Python SDK (experimental)

Requires Python 3.11+, Node.js, and an installed/built AppVanta MCP server.
From this repository, run `npm ci`, `npm run build`, then
`python -m pip install -r python/requirements.lock ./python`.
This source package has not been published to PyPI.

```python
import asyncio
from appvanta import AppVanta

async def main():
    async with AppVanta.connect("packages/mcp/dist/index.js", cwd=".") as app:
        print(app.server_version)
        print(await app.list_devices())
        print(await app.observe("emulator-5554"))

asyncio.run(main())
```

Use an absolute `server_script` when calling from another directory. `cwd` owns
the server's `.appvanta` task, lease, audit and evidence files. Keep that directory
when reconnecting. The SDK uses Node directly; it does not download an npm server.

`tools()` returns schemas. `call(name, arguments, timeout=seconds)` exposes every
server tool and decodes its JSON value. `call_raw()` preserves the complete MCP
result. Convenience methods include `observe`, `execute_action`, `run_flow`,
`start_flow`, `get_task` and `cancel_task`; they use the same server contracts.
Planner and Checker remain caller responsibilities.

Tool failures raise `AppVantaToolError` with `.tool` and `.result`. Malformed or
mixed-content successful responses raise `AppVantaResultError`; use `call_raw`
when consuming images or other content. Protocol and transport errors retain
their official MCP exception types. Nothing is automatically retried.

Keep the async context open until calls finish, and enter/exit it in the same
task. Request timeout/cancellation sends the protocol abandon notification;
it is not proof of device rollback or completed cleanup. Inspect saved evidence
and task/lease status before deciding whether to retry. Independent Flow workers
may continue after the client closes; manage them using task IDs.

The local stdio transport owns only its Node server process. It closes stdin,
waits for graceful exit, and escalates termination of that process within bounded
waits. It deliberately preserves detached workers recorded by AppVanta. The
generic MCP Windows transport's kill-on-close Job Object would terminate those
workers, so this package supplies its own transport to the official MCP client.
This is not a guarantee that arbitrary descendants survive an external host
process-tree kill or a containing operating-system Job Object.

The Node server cancels still-active request controllers when its stdin reaches
EOF. Wait for responses before closing stdin if you need their results; sending
all requests and immediately closing the stream requests shutdown. Completed
`start_flow` calls have already transferred work to independent workers, so
closing the connection does not cancel those tasks. Cleanup completion still
requires the corresponding task, lease or analysis evidence.

This initial SDK is not a stable API promise. Cross-platform installation,
real-device/OEM behavior, cancellation and disconnect combinations require their
own acceptance evidence. It reuses the official [MCP Python client](https://py.sdk.modelcontextprotocol.io/client/)
with `mcp==2.2.0`, using the legacy handshake supported by this AppVanta server.

Hosted installation evidence: public `99489ef`, run
[36673361082](https://github.com/williamwue/appvanta/actions/runs/36673361082), passed
all three host build jobs. Each host installed the wheel and completed the actual
Node server handshake, discovery of 60 tools, a missing-task error and a subsequent
successful tool listing. The 94-file evidence archive from each host was independently
verified for size and SHA-256 (282 files total). These host jobs do not exercise
Android actions; the device job and later trace-analysis jobs have separate gates.

| Host | Python SDK evidence |
|---|---|
| Windows | `python-sdk-1790746069101308600` |
| Linux | `python-sdk-1790746000590991789` |
| macOS | `python-sdk-1790746017639377000` |

Request-cancellation verifier: `scripts/verify-python-cancellation.py --trace
<retained-performance-probe-trace> --python <perfetto-python>` first analyzes the
original trace, then cancels an asyncio call while a real processor loads a
repeated-input fixture. It requires a cancelled receipt, both process exits,
absent success artifacts, and a usable MCP session afterward. This is distinct
from cancelling a persisted task or terminating its owner process.
