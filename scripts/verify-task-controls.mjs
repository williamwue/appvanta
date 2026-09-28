import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore, terminalTask } from '../packages/core/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deviceId = process.argv[2];
if (!deviceId) throw new Error('Usage: node scripts/verify-task-controls.mjs <device-id>');
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

const store = new TaskStore(resolve(root, '.appvanta/tasks'));
const flow = { version: 1, name: 'Task controls online verification', steps: [
  { description: 'First boundary', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'com.android.systemui' }, timeoutMs: 10000 } },
  { description: 'Final boundary', echo: 'finished' },
] };
async function waitPaused(id) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const task = await store.get(id);
    if (task.status === 'paused') return task;
    assert(!terminalTask(task.status), JSON.stringify(task));
    await delay(100);
  }
  throw new Error('Pause was not acknowledged by worker');
}
const records = [];
for (const cancel of [false, true]) {
  const started = await callThenStop('start_flow', { deviceId, flow });
  const taskId = started.started.taskId;
  try {
    await callOnce('pause_task', { taskId });
    const paused = await waitPaused(taskId);
    const queued = await callOnce('steer_task', { taskId, instruction: { description: 'Injected Home', action: { kind: 'button', button: 'home' } } });
    await delay(1000);
    assert.equal((await store.get(taskId)).status, 'paused');
    const pending = (await callOnce('list_task_instructions', { taskId })).result;
    assert.equal(pending.find(item => item.id === queued.result.id)?.status, 'queued');
    await callOnce(cancel ? 'cancel_task' : 'resume_task', { taskId });
    const completed = await waitForTerminal(store, taskId, terminalTask);
    assert.equal(completed.status, cancel ? 'cancelled' : 'passed', JSON.stringify(completed));
    const instructions = (await callOnce('list_task_instructions', { taskId })).result;
    assert.equal(instructions.find(item => item.id === queued.result.id)?.status, cancel ? 'queued' : 'applied');
    if (!cancel) {
      const steps = await readFile(join(completed.runDirectory, 'steps.jsonl'), 'utf8');
      assert(steps.includes('Injected Home'), 'Injected action missing from run evidence');
    }
    records.push({ started, paused, queued, completed, instructions });
  } catch (error) {
    await callOnce('cancel_task', { taskId }).catch(() => {});
    await waitForTerminal(store, taskId, terminalTask).catch(() => {});
    throw error;
  }
}
const evidence = resolve(root, '.appvanta/runs', `task-controls-${Date.now()}`);
await mkdir(evidence, { recursive: true });
await writeFile(join(evidence, 'verification.json'), JSON.stringify({ status: 'passed', deviceId, records }, null, 2));
console.log(JSON.stringify({ status: 'passed', evidence }));
