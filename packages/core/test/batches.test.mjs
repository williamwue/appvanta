import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BatchStore, parseFlow } from '../dist/index.js';

const flow = parseFlow({ name: 'batch', steps: [{ description: 'back', action: { kind: 'back' } }] });
test('batch records persist cancellation and protect terminal results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-batches-'));
  try {
    const owner = new BatchStore(root), reader = new BatchStore(root);
    await assert.rejects(owner.create(['a', 'a'], flow, 1), /unique/);
    const batch = await owner.create(['a', 'b'], flow, 2); batch.status = 'running'; await owner.save(batch);
    assert.equal((await reader.requestCancel(batch.id)).status, 'cancelling');
    assert.equal((await reader.get(batch.id)).status, 'cancelling');
    batch.status = 'cancelled'; batch.finishedAt = new Date().toISOString(); await owner.save(batch);
    assert.equal((await reader.get(batch.id)).status, 'cancelled');
    batch.error = 'rewrite'; await assert.rejects(owner.save(batch), /Terminal/);
    assert.equal((await reader.list()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('queued batch ownership transfers exactly once to an independent worker session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-batch-transfer-'));
  const ownerSession = '11111111-1111-4111-8111-111111111111', workerSession = '22222222-2222-4222-8222-222222222222';
  try {
    const owner = new BatchStore(root, ownerSession), worker = new BatchStore(root, workerSession);
    const batch = await owner.create(['device'], flow, 1), transferred = await owner.transferQueued(batch, process.pid, workerSession);
    assert.equal(transferred.owner.session, workerSession);
    await assert.rejects(owner.save(batch), /owner changed|another worker/i);
    const claimed = await worker.get(batch.id); claimed.status = 'running'; await worker.save(claimed);
    assert.equal((await owner.get(batch.id)).status, 'running');
    await assert.rejects(owner.transferQueued(batch, process.pid, workerSession), /changed|another worker/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
