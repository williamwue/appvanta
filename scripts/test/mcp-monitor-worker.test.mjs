import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MonitorStore } from '../../packages/core/dist/index.js';

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
}

test('start_monitor transfers ownership to a monitor worker independent of the MCP process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-monitor-worker-'));
  const child = spawn(process.execPath, [resolve('packages/mcp/dist/index.js')], { cwd: tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, APPVANTA_PROJECT_ROOT: root, PATH: '' } });
  const lines = createInterface({ input: child.stdout }), messages = [];
  lines.on('line', line => messages.push(JSON.parse(line)));
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  const waitFor = async id => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const message = messages.find(value => value.id === id); if (message) return message; await new Promise(done => setTimeout(done, 25)); }
    throw new Error(`MCP response timeout: ${id}`);
  };
  let monitorId, workerPid;
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'monitor-worker-test', version: '1' } } }); await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_monitor', arguments: { deviceId: 'offline-monitor-device', intervalMs: 500, durationMs: 1000 } } });
    const response = await waitFor(2); assert.equal(response.result.isError, undefined, JSON.stringify(response));
    const started = JSON.parse(response.result.content[0].text); monitorId = started.monitorId; workerPid = started.workerPid;
    assert.match(monitorId, /^monitor-/); assert.notEqual(workerPid, child.pid);
    const ready = JSON.parse(await readFile(join(root, '.appvanta', 'monitors', monitorId, 'worker.ready.json'))); assert.equal(ready.pid, workerPid);
    await stopProcess(child); lines.close();
    const store = new MonitorStore(join(root, '.appvanta', 'monitors')), deadline = Date.now() + 15000;
    let monitor;
    while (Date.now() < deadline) { monitor = await store.get(monitorId); if (monitor.status === 'failed') break; await new Promise(done => setTimeout(done, 25)); }
    assert.equal(monitor?.status, 'failed', JSON.stringify(monitor)); assert.equal(monitor.owner.pid, workerPid);
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) { try { process.kill(workerPid, 0); await new Promise(done => setTimeout(done, 25)); } catch { break; } }
  } finally {
    await stopProcess(child); lines.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
