import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskInstructionStore, TaskStore, parseFlow } from '../dist/index.js';

const flow = parseFlow({ name: 'steer', steps: [{ description: 'wait', action: { kind: 'back' } }] });
test('read-only instruction listing treats an absent directory as empty without creating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-instructions-'));
  try {
    const owner = new TaskStore(root), task = await owner.create('device', flow);
    const instructions = new TaskInstructionStore(owner);
    assert.deepEqual(await instructions.listReadOnly(task.id), []);
    assert.equal((await readdir(join(root, task.id))).includes('instructions'), false);
    assert.deepEqual(await instructions.list(task.id), []);
    assert.equal((await readdir(join(root, task.id))).includes('instructions'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('task instruction queue persists lifecycle and rejects terminal tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-instructions-'));
  try {
    const owner = new TaskStore(root), task = await owner.create('device', flow);
    const writer = new TaskInstructionStore(new TaskStore(root));
    const step = parseFlow({ name: 'instruction', steps: [{ description: 'go home', action: { kind: 'button', button: 'home' } }] }).steps[0];
    const queued = await writer.enqueue(task.id, step);
    assert.equal(queued.status, 'queued');
    const consumer = new TaskInstructionStore(owner);
    const claimed = await consumer.claimQueued(task.id);
    assert.deepEqual(claimed.map(value => value.id), [queued.id]);
    assert.equal((await consumer.claimQueued(task.id)).length, 0);
    assert.equal((await consumer.finish(task.id, queued.id, 'applied')).status, 'applied');
    await assert.rejects(consumer.finish(task.id, queued.id, 'failed'), /cannot finish/);
    task.status = 'passed'; task.finishedAt = new Date().toISOString(); await owner.save(task);
    await assert.rejects(writer.enqueue(task.id, step), /does not accept/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
