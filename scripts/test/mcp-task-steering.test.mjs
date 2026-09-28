import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TaskStore, parseFlow } from '../../packages/core/dist/index.js';

test('MCP queues and reads schema-validated task instructions across processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-mcp-steering-'));
  const store = new TaskStore(join(root, '.appvanta', 'tasks'));
  const flow = parseFlow({ name: 'pending', steps: [{ description: 'wait', action: { kind: 'back' } }] });
  const task = await store.create('device', flow); task.status = 'running'; await store.save(task);
  const child = spawn(process.execPath, [resolve('packages/mcp/dist/index.js')], { cwd: tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, APPVANTA_PROJECT_ROOT: root } });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  lines.on('line', line => messages.push(JSON.parse(line)));
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  const waitFor = async id => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const message = messages.find(value => value.id === id);
      if (message) return message;
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    throw new Error(`MCP response timeout: ${id}`);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'steer_task', arguments: { taskId: task.id, instruction: { description: 'Injected home', action: { kind: 'button', button: 'home' } } } } });
    const queuedMessage = await waitFor(2);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_task_instructions', arguments: { taskId: task.id } } });
    const listedMessage = await waitFor(3);
    const queued = JSON.parse(queuedMessage.result.content[0].text);
    const listed = JSON.parse(listedMessage.result.content[0].text);
    assert.equal(queued.status, 'queued');
    assert.deepEqual(listed.map(value => value.id), [queued.id]);
    assert.equal(listed[0].step.action.button, 'home');
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pause_task', arguments: { taskId: task.id } } });
    assert.equal(JSON.parse((await waitFor(4)).result.content[0].text).status, 'pausing');
    assert.equal(await store.pauseRequested(task.id), true);
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'resume_task', arguments: { taskId: task.id } } });
    assert.equal(JSON.parse((await waitFor(5)).result.content[0].text).status, 'running');
    assert.equal(await store.pauseRequested(task.id), false);
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    lines.close();
    task.status = 'passed'; task.finishedAt = new Date().toISOString(); await store.save(task);
    await rm(root, { recursive: true, force: true });
  }
});
