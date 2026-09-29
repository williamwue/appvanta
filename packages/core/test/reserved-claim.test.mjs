import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TaskStore, parseFlow } from '../dist/index.js';

const taskId = 'task-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reservationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const flow = parseFlow({ name: 'reserved', steps: [{ description: 'wait', action: { kind: 'wait', condition: { kind: 'text-visible', text: 'ready' }, timeoutMs: 1000 } }] });
const flowSha256 = createHash('sha256').update(JSON.stringify(flow)).digest('hex');
const marker = { version: 1, taskId, reservationId, reservationDigestSha256: 'c'.repeat(64), deviceId: 'emulator', flowSha256 };

async function fixture(owner = { pid: 2147483647, host: hostname(), session: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }) {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-reserved-claim-'));
  const dir = join(root, taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'reservation.json'), JSON.stringify(marker));
  await writeFile(join(dir, 'task.json'), JSON.stringify({ version: 1, id: taskId, deviceId: 'emulator', flow,
    owner, startedAt: new Date().toISOString(), revision: 2, status: 'queued' }));
  return { root, store: new TaskStore(root), receipt: { id: reservationId, digestSha256: marker.reservationDigestSha256 } };
}

test('adopts a queued reserved task only from a dead local owner and claims it idempotently', async () => {
  const f = await fixture();
  try {
    const adopted = await f.store.adoptReserved(taskId, f.receipt, 2);
    assert.equal(adopted.status, 'queued');
    assert.equal(adopted.owner.pid, process.pid);
    assert.equal(adopted.owner.host, hostname());
    assert.equal(adopted.revision, 3);
    const claimed = await f.store.claimReserved(taskId, f.receipt, 3);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.revision, 4);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, taskId, 'task.json'))), claimed);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('reserved claim rejects marker mismatch, stale revision, and a live owner', async () => {
  const f = await fixture({ pid: process.pid, host: hostname(), session: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });
  try {
    await assert.rejects(f.store.claimReserved(taskId, { ...f.receipt, digestSha256: 'f'.repeat(64) }), /marker/);
    await assert.rejects(f.store.claimReserved(taskId, f.receipt, 1), /revision/);
    await assert.rejects(f.store.claimReserved(taskId, f.receipt, 2), /alive/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('concurrent independent reserved claims fail closed at the filesystem claim lock', async () => {
  const f = await fixture();
  try {
    const left = new TaskStore(f.root, '11111111-1111-4111-8111-111111111111');
    const right = new TaskStore(f.root, '22222222-2222-4222-8222-222222222222');
    const results = await Promise.allSettled([
      left.claimReserved(taskId, f.receipt, 2), right.claimReserved(taskId, f.receipt, 2),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.match(String(results.find(result => result.status === 'rejected')?.reason), /claim|queued/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('reserved claim recovers only a stale local claim lock', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, taskId, 'reserved-claim.lock'), JSON.stringify({ version: 1, pid: 2147483647,
      host: hostname(), session: 'ffffffff-ffff-4fff-8fff-ffffffffffff', startedAt: new Date().toISOString(), revision: 2 }));
    const claimed = await f.store.claimReserved(taskId, f.receipt, 2);
    assert.equal(claimed.status, 'running');
    assert.equal(await readFile(join(f.root, taskId, 'reserved-claim.lock')).catch(() => undefined), undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('reserved running recovery requires no execution evidence and a dead owner', async () => {
  const f = await fixture();
  try {
    const running = { version: 1, id: taskId, deviceId: 'emulator', flow,
      owner: { pid: 2147483647, host: hostname(), session: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      startedAt: new Date().toISOString(), revision: 2, status: 'running' };
    await writeFile(join(f.root, taskId, 'task.json'), JSON.stringify(running));
    const recovered = await f.store.recoverReservedRunning(taskId, f.receipt, 2);
    assert.equal(recovered.status, 'running');
    assert.equal(recovered.owner.pid, process.pid);
    assert.equal(recovered.revision, 3);
    const snapshot = await readFile(join(f.root, taskId, 'task.json'), 'utf8');
    await assert.rejects(f.store.recoverReservedRunning(taskId, f.receipt, 3), /alive/);
    assert.equal(await readFile(join(f.root, taskId, 'task.json'), 'utf8'), snapshot);
    await writeFile(join(f.root, taskId, 'task.json'), JSON.stringify({ ...running, runDirectory: join(f.root, 'run') }));
    await assert.rejects(f.store.recoverReservedRunning(taskId, f.receipt, 2), /queued|execution evidence/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
