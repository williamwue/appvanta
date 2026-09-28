import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function client() {
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const input = createInterface({ input: child.stdout });
  const pending = new Map(); let sequence = 0;
  input.on('line', line => {
    const message = JSON.parse(line), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else if (message.result.isError) request.reject(new Error(message.result.content[0].text));
    else request.resolve(JSON.parse(message.result.content[0].text));
  });
  child.on('exit', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('MCP exited')); } pending.clear(); });
  child.stdin.write([{ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verifier', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }].map(JSON.stringify).join('\n') + '\n');
  return {
    async close() { if (child.exitCode === null && !child.killed) { const closed = once(child, 'exit'); child.kill(); await closed; } input.close(); },
    tool(name, args) { return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${name}`)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    }) },
  };
}
const serial = process.argv[2]; assert(serial, 'Usage: node scripts/verify-tasks.mjs <device>');
const root = resolve('.appvanta/runs', `task-persistence-${Date.now()}`);
await mkdir(root, { recursive: true });
const owner = client(), observer = client();
let taskId;
async function waitFor(reader, predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const task = await reader.tool('get_task', { taskId }); if (predicate(task)) return task; await delay(100); }
  throw new Error('Task state deadline exceeded');
}
try {
  const flow = { version: 1, name: 'Persisted cancellation test', steps: [{ description: 'Wait for nonexistent package', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'net.appvanta.notinstalled' }, timeoutMs: 60000 } }] };
  ({ taskId } = await owner.tool('start_flow', { deviceId: serial, flow }));
  const running = await waitFor(observer, task => task.status === 'running' && task.runDirectory);
  assert.equal(JSON.parse(await readFile(join('.appvanta/tasks', taskId, 'task.json'))).runDirectory, running.runDirectory);
  assert((await observer.tool('list_tasks', {})).some(task => task.id === taskId));
  await delay(3000);
  const startedCancel = Date.now();
  const cancelling = await observer.tool('cancel_task', { taskId });
  assert.equal(cancelling.status, 'cancelling');
  const completed = await waitFor(observer, task => ['passed', 'failed', 'cancelled'].includes(task.status));
  assert.equal(completed.status, 'cancelled'); assert(Date.now() - startedCancel < 10000);
  assert.equal(JSON.parse(await readFile(join(completed.runDirectory, 'run.json'))).status, 'cancelled');
  await owner.close(); await observer.close();
  const restarted = client();
  try {
    const recovered = await restarted.tool('get_task', { taskId });
    assert.deepEqual(recovered, completed);
    assert.equal((await restarted.tool('cancel_task', { taskId })).status, 'cancelled');
    const verification = { status: 'passed', taskId, runDirectory: completed.runDirectory, crossProcessQuery: true, crossProcessCancel: true, restartQuery: true };
    await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
    console.log(JSON.stringify({ ...verification, evidence: root }));
  } finally { await restarted.close(); }
} finally {
  if (taskId) {
    const cleanup = client();
    try {
      await cleanup.tool('cancel_task', { taskId });
      await waitFor(cleanup, task => ['passed', 'failed', 'cancelled', 'interrupted'].includes(task.status));
    } finally { await cleanup.close(); }
  }
  await owner.close(); await observer.close();
}
