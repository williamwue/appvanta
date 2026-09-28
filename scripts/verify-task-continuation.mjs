import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { TaskStore, inspectDeviceLock } from '../packages/core/dist/index.js';

const deviceId = process.argv[2];
if (!deviceId) throw new Error('Usage: node scripts/verify-task-continuation.mjs <device-id>');
const root = resolve(import.meta.dirname, '..');
const directory = join(root, '.appvanta/runs', `task-continuation-${Date.now()}`);
await mkdir(directory, { recursive: true });
const store = new TaskStore(join(root, '.appvanta/tasks'));
const records = [];
const transport = process.argv[3] ?? 'cli';
const cancel = process.argv[4] === 'cancel';
const crash = process.argv[4] === 'crash';
if ((cancel || crash) && transport !== 'worker') throw new Error('Interruption scenario requires worker transport');
if (!['cli', 'mcp', 'worker'].includes(transport)) throw new Error('Transport must be cli, mcp or worker');
async function mcpContinue(args) {
  const checkpoint = JSON.parse(await readFile(args[3], 'utf8'));
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  let result;
  lines.on('line', line => {
    const response = JSON.parse(line);
    if (response.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: transport === 'worker' ? 'start_task_continuation' : 'continue_task', arguments: { taskId: args[1], leaseToken: args[2], checkpoint } } }) + '\n');
    }
    if (response.id === 2) { result = response; child.stdin.end(); }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'continuation-verifier', version: '1' } } }) + '\n');
  try {
    await exited; assert(result, `MCP exited without continuation result: ${stderr}`);
    if (transport === 'worker' && !result.error && !result.result?.isError) {
      const started = JSON.parse(result.result.content[0].text);
      assert.notEqual(started.workerPid, child.pid);
      const readyTask = await store.get(started.taskId);
      assert(readyTask.runDirectory, 'Ready successor must already have a bound run');
      const readyLease = JSON.parse(await readFile(join(readyTask.runDirectory, 'device-lease.json'), 'utf8'));
      assert.equal(readyLease.pid, started.workerPid);
      assert.equal(readyLease.deviceId, deviceId);
      await readFile(join(readyTask.runDirectory, 'flow.json'), 'utf8');
      await readFile(join(readyTask.runDirectory, 'progress.json'), 'utf8');
      const deadline = Date.now() + 90000;
      let cancellation;
      while (Date.now() < deadline) {
        const task = await store.get(started.taskId);
        if ((cancel || crash) && !cancellation && task.runDirectory) {
          let progress;
          try { progress = JSON.parse(await readFile(join(task.runDirectory, 'progress.json'), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (progress?.phase === 'executing') {
            if (crash) {
              const owned = await inspectDeviceLock(deviceId);
              assert.equal(owned.lease.pid, started.workerPid);
              assert.equal(task.owner.pid, started.workerPid);
              process.kill(started.workerPid, 'SIGKILL');
            } else {
              const response = await cli(['cancel-task', task.id]); assert.equal(response.code, 0, response.stderr);
            }
            cancellation = { requestedAt: new Date().toISOString(), afterMcpExit: true, phase: progress.phase, method: crash ? 'SIGKILL' : 'cancel-task' };
          }
        }
        const lease = await inspectDeviceLock(deviceId);
        if (['passed', 'failed', 'cancelled', ...(crash ? ['interrupted'] : [])].includes(task.status) && (!lease || lease.owner === 'dead')) {
          if (cancel || crash) assert(cancellation, 'Interruption must occur while the checkpoint is executing');
          return { code: task.status === 'passed' ? 0 : 1, stdout: JSON.stringify(result), stderr, mcpPid: child.pid, workerPid: started.workerPid, cancellation };
        }
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error('Continuation worker did not finish after MCP exit');
    }
    return { code: result.error || result.result?.isError ? 1 : 0, stdout: JSON.stringify(result), stderr };
  } finally { clearTimeout(timer); lines.close(); }
}
async function cli(args) {
  if (transport !== 'cli' && args[0] === 'continue-task') return mcpContinue(args);
  const child = spawn(process.execPath, ['packages/cli/dist/index.js', ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  try { const [code] = await once(child, 'exit'); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}
for (const mismatch of cancel || crash ? [true] : [false, true]) {
  const source = `
    import { TaskStore, parseFlow } from ${JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href)};
    import { runAndroidFlow } from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};
    const store = new TaskStore(${JSON.stringify(store.directory)});
    const flow = parseFlow({ name: 'Continuation device check', steps: [
      { description: 'Completed Home action', action: { kind: 'button', button: 'home' } },
      { description: 'Remaining Back action', action: { kind: 'back' } },
      { description: 'Final evidence', echo: 'continued' }
    ] });
    const task = await store.create(${JSON.stringify(deviceId)}, flow);
    task.status = 'running'; await store.save(task);
    let boundary = 0;
    await runAndroidFlow(task.deviceId, flow, undefined, async root => { task.runDirectory = root; await store.save(task); }, {
      drain: async () => [], finish: async () => {}, beforeStep: async () => {
        if (++boundary === 2) { process.send({ taskId: task.id, root: task.runDirectory }); await new Promise(() => setInterval(() => {}, 1000)); }
      }
    });
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; owner.stderr.on('data', data => { stderr += data; });
  const exited = once(owner, 'exit');
  try {
    const [message] = await Promise.race([
      once(owner, 'message', { signal: AbortSignal.timeout(90000) }),
      exited.then(() => { throw new Error(`Owner exited before boundary: ${stderr}`); }),
    ]);
    owner.kill('SIGKILL'); await exited;
    assert.equal((await store.get(message.taskId)).status, 'interrupted');
    const lease = await inspectDeviceLock(deviceId); assert.equal(lease.owner, 'dead');
    const checkpoint = mismatch ? { kind: 'text-visible', text: `missing-${Date.now()}` } : { kind: 'app-running', packageName: 'com.android.systemui' };
    const path = join(directory, mismatch ? 'mismatch.json' : 'checkpoint.json'); await writeFile(path, JSON.stringify(checkpoint));
    const result = await cli(['continue-task', message.taskId, lease.lease.token, path]);
    const successor = JSON.parse(await readFile(join(store.directory, message.taskId, 'continuation/successor.json'), 'utf8'));
    const task = await store.get(successor.taskId);
    assert.equal(task.status, crash ? 'interrupted' : cancel ? 'cancelled' : mismatch ? 'failed' : 'passed', JSON.stringify({ task, result }));
    let notification;
    const notificationPath = join(store.directory, task.id, 'notifications/completion.json');
    if (crash) {
      await assert.rejects(readFile(notificationPath), { code: 'ENOENT' });
      const inspection = await cli(['inspect-task-progress', task.id]);
      assert.equal(inspection.code, 1);
      assert(JSON.parse(inspection.stdout).reasons.includes('phase-executing'));
      const retained = await inspectDeviceLock(deviceId);
      const retry = await cli(['continue-task', task.id, retained.lease.token, path]);
      assert.equal(retry.code, 1);
    } else {
      notification = JSON.parse(await readFile(notificationPath, 'utf8'));
      assert.equal(notification.event.status, task.status);
      assert.equal(notification.event.taskId, task.id);
      assert.equal(notification.delivery, 'local');
    }
    assert.equal(result.code, mismatch ? 1 : 0);
    let stepLog = '';
    try { stepLog = await readFile(join(task.runDirectory, 'steps.jsonl'), 'utf8'); }
    catch (error) { if (!crash || error.code !== 'ENOENT') throw error; }
    const steps = stepLog.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert(!steps.some(step => step.description === 'Completed Home action'));
    assert.equal(steps.length, crash ? 0 : mismatch ? 1 : 3);
    if (!crash) assert.equal(steps[0].description, 'Verify continuation checkpoint');
    const link = JSON.parse(await readFile(join(task.runDirectory, 'continuation.json'), 'utf8'));
    assert.equal(link.sourceTaskId, message.taskId);
    assert.equal((await store.get(message.taskId)).status, 'interrupted');
    const duplicate = await cli(['continue-task', message.taskId, lease.lease.token, path]); assert.equal(duplicate.code, 1);
    if (mismatch) {
      const retained = await inspectDeviceLock(deviceId); assert.equal(retained.owner, 'dead');
      const recovery = await cli(['recover-flow', deviceId, retained.lease.token]); assert.equal(recovery.code, 0, recovery.stderr);
    }
    assert.equal(await inspectDeviceLock(deviceId), null);
    records.push({ mismatch, cancel, crash, sourceTaskId: message.taskId, sourceRun: message.root, taskId: task.id, runDirectory: task.runDirectory, status: task.status, steps: steps.length, mcpPid: result.mcpPid, workerPid: result.workerPid, cancellation: result.cancellation, notification: notification?.path });
    await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: records.length === (cancel || crash ? 1 : 2) ? 'passed' : 'running', transport, records }, null, 2));
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exited; }
  }
}
console.log(JSON.stringify({ status: 'passed', directory, records }, null, 2));
