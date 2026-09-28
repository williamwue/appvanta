import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BatchStore } from '../../packages/core/dist/index.js';

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
}

test('start_flows transfers ownership to a batch worker independent of the MCP process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-batch-worker-'));
  const child = spawn(process.execPath, [resolve('packages/mcp/dist/index.js')], { cwd: tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, APPVANTA_PROJECT_ROOT: root, PATH: '' } });
  const lines = createInterface({ input: child.stdout }), messages = [];
  lines.on('line', line => messages.push(JSON.parse(line)));
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  const waitFor = async id => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const message = messages.find(value => value.id === id); if (message) return message; await new Promise(done => setTimeout(done, 25)); }
    throw new Error(`MCP response timeout: ${id}`);
  };
  let batchId, workerPid;
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'batch-worker-test', version: '1' } } }); await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_flows', arguments: { deviceIds: ['offline-batch-device'], concurrency: 1, flow: { name: 'batch worker ownership', steps: [{ description: 'back', action: { kind: 'back' } }] } } } });
    const response = await waitFor(2); assert.equal(response.result.isError, undefined, JSON.stringify(response));
    const started = JSON.parse(response.result.content[0].text); batchId = started.batchId; workerPid = started.workerPid;
    assert.match(batchId, /^batch-task-/); assert.notEqual(workerPid, child.pid);
    const ready = JSON.parse(await readFile(join(root, '.appvanta', 'batches', batchId, 'worker.ready.json')));
    assert.equal(ready.pid, workerPid);
    await stopProcess(child); lines.close();
    const store = new BatchStore(join(root, '.appvanta', 'batches')), deadline = Date.now() + 15000;
    let batch;
    while (Date.now() < deadline) { batch = await store.get(batchId); if (batch.status === 'failed') break; await new Promise(done => setTimeout(done, 25)); }
    assert.equal(batch?.status, 'failed', JSON.stringify(batch)); assert.equal(batch.owner.pid, workerPid);
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) { try { process.kill(workerPid, 0); await new Promise(done => setTimeout(done, 25)); } catch { break; } }
  } finally {
    await stopProcess(child); lines.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
