import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskStore, parseFlow } from '../dist/index.js';

const flow = parseFlow({ name: 'persisted', steps: [{ description: 'back', action: { kind: 'back' } }] });
test('task snapshots survive reopening, serialize updates and protect terminal history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-tasks-'));
  try {
    const owner = new TaskStore(root), reader = new TaskStore(root);
    const task = await owner.create('device', flow);
    task.status = 'running';
    const running = owner.save(task);
    task.runDirectory = 'run-path';
    await Promise.all([running, owner.save(task)]);
    assert.equal((await reader.get(task.id)).runDirectory, 'run-path');
    assert.equal((await reader.requestPause(task.id)).status, 'pausing');
    assert.equal(await owner.pauseRequested(task.id), true);
    task.status = 'paused'; await owner.save(task);
    assert.equal((await reader.get(task.id)).status, 'paused');
    assert.equal((await reader.requestResume(task.id)).status, 'running');
    assert.equal(await owner.pauseRequested(task.id), false);
    task.status = 'running'; await owner.save(task);
    assert.equal((await readdir(join(root, task.id, 'controls'))).length, 2);
    assert.equal((await reader.requestCancel(task.id)).status, 'cancelling');
    assert.equal((await reader.get(task.id)).status, 'cancelling');
    assert.equal(await owner.cancellationRequested(task.id), true);
    task.status = 'cancelled'; await owner.save(task);
    assert.equal((await new TaskStore(root).get(task.id)).status, 'cancelled');
    assert.equal((await reader.requestCancel(task.id)).status, 'cancelled');
    task.status = 'passed';
    await assert.rejects(owner.save(task), /Terminal/);
    assert.equal((await reader.get(task.id)).status, 'cancelled');
    await assert.rejects(reader.save(task), /owned/);
    await assert.rejects(reader.get('../escape'), /Invalid task id/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exited worker is interrupted while completed worker history remains passed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-task-death-'));
  try {
    const module = new URL('../dist/index.js', import.meta.url).href;
    const code = `import { TaskStore } from ${JSON.stringify(module)};
      const store=new TaskStore(process.argv[1]);
      const task=await store.create('device', ${JSON.stringify(flow)});
      task.status=process.argv[2]; await store.save(task); console.log(task.id);`;
    const exec = promisify(execFile), store = new TaskStore(root);
    for (const status of ['running', 'passed']) {
      const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code, root, status]);
      const id = stdout.trim();
      const result = await store.get(id);
      assert.equal(result.status, status === 'running' ? 'interrupted' : 'passed');
      assert.equal(JSON.parse(await readFile(join(root, id, 'task.json'))).status, status, 'Queries must preserve original evidence');
    }
    assert.equal((await store.list()).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('queued task ownership transfers exactly once to an independent worker session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-task-transfer-'));
  const ownerSession = '11111111-1111-4111-8111-111111111111', workerSession = '22222222-2222-4222-8222-222222222222';
  try {
    const owner = new TaskStore(root, ownerSession), worker = new TaskStore(root, workerSession);
    const task = await owner.create('device', flow), transferred = await owner.transferQueued(task, process.pid, workerSession);
    assert.equal(transferred.owner.session, workerSession);
    await assert.rejects(owner.save(task), /owner changed|another worker/i);
    const claimed = await worker.get(task.id); claimed.status = 'running'; await worker.save(claimed);
    assert.equal((await owner.get(task.id)).status, 'running');
    await assert.rejects(owner.transferQueued(task, process.pid, workerSession), /changed|another worker/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
