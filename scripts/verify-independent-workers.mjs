import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BatchStore, MonitorStore, TaskStore, terminalBatch, terminalMonitor, terminalTask } from '../packages/core/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deviceId = process.argv[2];
if (!deviceId) throw new Error('Usage: node scripts/verify-independent-workers.mjs <device-id>');
const delay = ms => new Promise(done => setTimeout(done, ms));

async function startMcp() {
  const child = spawn(process.execPath, [resolve(root, 'packages/mcp/dist/index.js')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, APPVANTA_PROJECT_ROOT: root } });
  const messages = [], errors = [], output = createInterface({ input: child.stdout }), stderr = createInterface({ input: child.stderr });
  output.on('line', line => messages.push(JSON.parse(line))); stderr.on('line', line => errors.push(line));
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  const waitFor = async id => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const message = messages.find(value => value.id === id); if (message) return message; await delay(25); }
    throw new Error(`MCP response timeout ${id}: ${errors.join('\n')}`);
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'independent-worker-verifier', version: '1' } } });
  const initialized = await waitFor(1); assert(initialized.result, JSON.stringify(initialized));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { child, output, stderr, send, waitFor };
}

async function stopMcp(mcp) {
  if (mcp.child.exitCode === null && mcp.child.signalCode === null) mcp.child.kill();
  const deadline = Date.now() + 5000;
  while (mcp.child.exitCode === null && mcp.child.signalCode === null && Date.now() < deadline) await delay(25);
  mcp.output.close(); mcp.stderr.close();
  assert(mcp.child.exitCode !== null || mcp.child.signalCode !== null, 'MCP process did not exit');
  return new Date().toISOString();
}

async function callThenStop(name, args) {
  const mcp = await startMcp();
  try {
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    const response = await mcp.waitFor(2);
    assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    const started = JSON.parse(response.result.content[0].text);
    assert.notEqual(started.workerPid, mcp.child.pid);
    const mcpPid = mcp.child.pid, mcpExitedAt = await stopMcp(mcp);
    return { started, mcpPid, mcpExitedAt };
  } catch (error) { await stopMcp(mcp).catch(() => {}); throw error; }
}

async function callOnce(name, args) {
  const mcp = await startMcp();
  try {
    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    const response = await mcp.waitFor(2); assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    const result = JSON.parse(response.result.content[0].text), mcpPid = mcp.child.pid, mcpExitedAt = await stopMcp(mcp);
    return { result, mcpPid, mcpExitedAt };
  } catch (error) { await stopMcp(mcp).catch(() => {}); throw error; }
}

async function waitForTerminal(store, id, terminal) {
  const deadline = Date.now() + 90000;
  let record;
  while (Date.now() < deadline) { record = await store.get(id); if (terminal(record.status)) return record; await delay(100); }
  throw new Error(`Worker ${id} did not finish: ${JSON.stringify(record)}`);
}

const startedAt = new Date().toISOString();
const stableFlow = { version: 1, name: 'MCP owner exit verification', steps: [{ description: 'Wait for a stable screen after MCP exits', action: { kind: 'wait', condition: { kind: 'screen-stable', stableMs: 3000 }, timeoutMs: 15000 } }] };

const taskStart = await callThenStop('start_flow', { deviceId, flow: stableFlow });
const task = await waitForTerminal(new TaskStore(resolve(root, '.appvanta/tasks')), taskStart.started.taskId, terminalTask);
assert.equal(task.status, 'passed', JSON.stringify(task)); assert(Date.parse(task.finishedAt) >= Date.parse(taskStart.mcpExitedAt));

const batchStart = await callThenStop('start_flows', { deviceIds: [deviceId], concurrency: 1, flow: stableFlow });
const batch = await waitForTerminal(new BatchStore(resolve(root, '.appvanta/batches')), batchStart.started.batchId, terminalBatch);
assert.equal(batch.status, 'passed', JSON.stringify(batch)); assert(Date.parse(batch.finishedAt) >= Date.parse(batchStart.mcpExitedAt));

const monitorStart = await callThenStop('start_monitor', { deviceId, intervalMs: 500, durationMs: 4000 });
const monitor = await waitForTerminal(new MonitorStore(resolve(root, '.appvanta/monitors')), monitorStart.started.monitorId, terminalMonitor);
assert.equal(monitor.status, 'completed', JSON.stringify(monitor)); assert(monitor.sampleCount > 0); assert(Date.parse(monitor.finishedAt) >= Date.parse(monitorStart.mcpExitedAt));

const blockingFlow = { version: 1, name: 'Cross-process cancellation verification', steps: [{ description: 'Wait for an intentionally absent marker', action: { kind: 'wait', condition: { kind: 'text-visible', text: `APPVANTA_ABSENT_${Date.now()}` }, timeoutMs: 60000 } }] };
const cancelledTaskStart = await callThenStop('start_flow', { deviceId, flow: blockingFlow });
const taskCancellation = await callOnce('cancel_task', { taskId: cancelledTaskStart.started.taskId });
const cancelledTask = await waitForTerminal(new TaskStore(resolve(root, '.appvanta/tasks')), cancelledTaskStart.started.taskId, terminalTask);
assert.equal(cancelledTask.status, 'cancelled', JSON.stringify(cancelledTask)); assert(Date.parse(cancelledTask.finishedAt) >= Date.parse(cancelledTaskStart.mcpExitedAt));

const cancelledBatchStart = await callThenStop('start_flows', { deviceIds: [deviceId], concurrency: 1, flow: blockingFlow });
const batchCancellation = await callOnce('cancel_batch', { batchId: cancelledBatchStart.started.batchId });
const cancelledBatch = await waitForTerminal(new BatchStore(resolve(root, '.appvanta/batches')), cancelledBatchStart.started.batchId, terminalBatch);
assert.equal(cancelledBatch.status, 'cancelled', JSON.stringify(cancelledBatch)); assert(Date.parse(cancelledBatch.finishedAt) >= Date.parse(cancelledBatchStart.mcpExitedAt));

const releasedMonitorStart = await callThenStop('start_monitor', { deviceId, intervalMs: 500, durationMs: 30000 });
const monitorRelease = await callOnce('release_monitor', { monitorId: releasedMonitorStart.started.monitorId });
const releasedMonitor = await waitForTerminal(new MonitorStore(resolve(root, '.appvanta/monitors')), releasedMonitorStart.started.monitorId, terminalMonitor);
assert.equal(releasedMonitor.status, 'released', JSON.stringify(releasedMonitor)); assert(Date.parse(releasedMonitor.finishedAt) >= Date.parse(releasedMonitorStart.mcpExitedAt));

const id = `worker-restart-check-${Date.now()}`, evidenceDirectory = resolve(root, '.appvanta/runs', id);
await mkdir(evidenceDirectory, { recursive: false });
const verification = {
  version: 1, id, startedAt, finishedAt: new Date().toISOString(), deviceId,
  checks: [
    { capability: 'start_flow', passed: true, mcpPid: taskStart.mcpPid, mcpExitedAt: taskStart.mcpExitedAt, workerPid: taskStart.started.workerPid, recordId: task.id, status: task.status, finishedAt: task.finishedAt, runDirectory: task.runDirectory },
    { capability: 'start_flows', passed: true, mcpPid: batchStart.mcpPid, mcpExitedAt: batchStart.mcpExitedAt, workerPid: batchStart.started.workerPid, recordId: batch.id, status: batch.status, finishedAt: batch.finishedAt, runDirectory: batch.runDirectory },
    { capability: 'start_monitor', passed: true, mcpPid: monitorStart.mcpPid, mcpExitedAt: monitorStart.mcpExitedAt, workerPid: monitorStart.started.workerPid, recordId: monitor.id, status: monitor.status, finishedAt: monitor.finishedAt, sampleCount: monitor.sampleCount, rootDirectory: monitor.rootDirectory },
    { capability: 'cancel_task', passed: true, mcpPid: cancelledTaskStart.mcpPid, mcpExitedAt: cancelledTaskStart.mcpExitedAt, controllerMcpPid: taskCancellation.mcpPid, workerPid: cancelledTaskStart.started.workerPid, recordId: cancelledTask.id, status: cancelledTask.status, finishedAt: cancelledTask.finishedAt, runDirectory: cancelledTask.runDirectory },
    { capability: 'cancel_batch', passed: true, mcpPid: cancelledBatchStart.mcpPid, mcpExitedAt: cancelledBatchStart.mcpExitedAt, controllerMcpPid: batchCancellation.mcpPid, workerPid: cancelledBatchStart.started.workerPid, recordId: cancelledBatch.id, status: cancelledBatch.status, finishedAt: cancelledBatch.finishedAt, runDirectory: cancelledBatch.runDirectory },
    { capability: 'release_monitor', passed: true, mcpPid: releasedMonitorStart.mcpPid, mcpExitedAt: releasedMonitorStart.mcpExitedAt, controllerMcpPid: monitorRelease.mcpPid, workerPid: releasedMonitorStart.started.workerPid, recordId: releasedMonitor.id, status: releasedMonitor.status, finishedAt: releasedMonitor.finishedAt, sampleCount: releasedMonitor.sampleCount, rootDirectory: releasedMonitor.rootDirectory },
  ],
};
await writeFile(join(evidenceDirectory, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: 'passed', evidenceDirectory, checks: verification.checks }));
