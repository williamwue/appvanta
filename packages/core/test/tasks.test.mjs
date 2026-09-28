import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('queued transfer serializes against a stale save and preserves the newer owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-task-persist-race-'));
  const ownerSession = '33333333-3333-4333-8333-333333333333', workerSession = '44444444-4444-4444-8444-444444444444';
  try {
    const owner = new TaskStore(root, ownerSession), task = await owner.create('device', flow);
    const transfer = owner.transferQueued(task, process.pid, workerSession);
    const stale = { ...task, status: 'running' };
    const save = owner.save(stale);
    const [transferred, saved] = await Promise.allSettled([transfer, save]);
    assert.equal(transferred.status, 'fulfilled');
    assert.equal(saved.status, 'rejected');
    assert.match(String(saved.reason), /owner changed|another worker/i);
    const persisted = JSON.parse(await readFile(join(root, task.id, 'task.json')));
    assert.equal(persisted.owner.session, workerSession);
    assert.equal(persisted.status, 'queued');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('queued transfer preserves metadata persisted after the caller snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-task-transfer-metadata-'));
  const workerSession = '55555555-5555-4555-8555-555555555555';
  try {
    const owner = new TaskStore(root), task = await owner.create('device', flow), stale = { ...task };
    task.runDirectory = 'latest-run';
    await owner.save(task);
    await assert.rejects(owner.transferQueued(stale, process.pid, workerSession), /revision changed/i);
    const transferred = await owner.transferQueued(await owner.get(task.id), process.pid, workerSession);
    assert.equal(transferred.runDirectory, 'latest-run');
    assert.equal(JSON.parse(await readFile(join(root, task.id, 'task.json'))).runDirectory, 'latest-run');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale save rejects after another writer advances task metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-task-save-revision-'));
  const session = '66666666-6666-4666-8666-666666666666';
  try {
    const writer = new TaskStore(root, session), otherWriter = new TaskStore(root, session);
    const task = await writer.create('device', flow), stale = { ...task };
    task.runDirectory = 'newest-run'; await writer.save(task);
    stale.runDirectory = 'stale-run';
    await assert.rejects(otherWriter.save(stale), /revision changed/i);
    assert.equal(JSON.parse(await readFile(join(root, task.id, 'task.json'))).runDirectory, 'newest-run');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task publication rejects tampered owner identity and revision records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-task-persist-tamper-'));
  const session = '77777777-7777-4777-8777-777777777777', workerSession = '88888888-8888-4888-8888-888888888888';
  try {
    const owner = new TaskStore(root, session), task = await owner.create('device', flow);
    const path = join(root, task.id, 'task.json');
    const ownerTampered = JSON.parse(await readFile(path, 'utf8'));
    ownerTampered.owner.pid = process.pid + 1;
    await writeFile(path, JSON.stringify(ownerTampered));
    await assert.rejects(owner.save(task), /owner changed/i);
    const restored = { ...ownerTampered, owner: { ...ownerTampered.owner, pid: process.pid, host: ownerTampered.owner.host } };
    await writeFile(path, JSON.stringify(restored));
    const transferred = await owner.transferQueued(task, process.pid, workerSession);
    const transferredPath = join(root, task.id, 'task.json');
    const revisionTampered = JSON.parse(await readFile(transferredPath, 'utf8'));
    revisionTampered.revision = 'bad';
    await writeFile(transferredPath, JSON.stringify(revisionTampered));
    await assert.rejects(owner.failTransferredStartup(task.id, process.pid, workerSession, 'startup'), /revision/i);
    assert.equal(JSON.parse(await readFile(transferredPath, 'utf8')).revision, 'bad');
    assert.equal(transferred.owner.session, workerSession);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task revision overflow fails before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-task-revision-overflow-'));
  try {
    const owner = new TaskStore(root), task = await owner.create('device', flow);
    const path = join(root, task.id, 'task.json');
    const tampered = JSON.parse(await readFile(path, 'utf8'));
    tampered.revision = Number.MAX_SAFE_INTEGER;
    await writeFile(path, JSON.stringify(tampered));
    await assert.rejects(owner.save({ ...task, revision: Number.MAX_SAFE_INTEGER }), /overflow/i);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, Number.MAX_SAFE_INTEGER);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reserved task publication is idempotent and fails closed on ambiguous or mismatched artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-reserved-task-'));
  const reservation = { id: '11111111-1111-4111-8111-111111111111', digestSha256: 'a'.repeat(64) };
  try {
    const store = new TaskStore(root), id = 'task-22222222-2222-4222-8222-222222222222';
    const [first, second] = await Promise.all([1, 2].map(() => store.createReserved(id, 'device', flow, reservation)));
    assert.equal(first.id, id); assert.equal(second.id, id);
    assert.deepEqual(first.flow, second.flow);
    assert.deepEqual(JSON.parse(await readFile(join(root, id, 'reservation.json'))), {
      version: 1, taskId: id, reservationId: reservation.id, reservationDigestSha256: reservation.digestSha256,
      deviceId: 'device', flowSha256: createHash('sha256').update(JSON.stringify(flow)).digest('hex'),
    });
    await assert.rejects(store.createReserved(id, 'other-device', flow, reservation), /marker|identity|differs/);
    await assert.rejects(new TaskStore(root, '99999999-9999-4999-8999-999999999999')
      .createReserved(id, 'device', flow, reservation), /live worker/);
    const taskPath = join(root, id, 'task.json');
    const foreign = JSON.parse(await readFile(taskPath, 'utf8'));
    foreign.owner = { ...foreign.owner, host: 'untrusted-host' };
    await writeFile(taskPath, JSON.stringify(foreign));
    await assert.rejects(store.createReserved(id, 'device', flow, reservation), /unknown|adoption/);

    const ambiguous = 'task-33333333-3333-4333-8333-333333333333';
    await mkdir(join(root, ambiguous));
    await assert.rejects(store.createReserved(ambiguous, 'device', flow, reservation), /missing.*marker|ambiguous/i);
    const mismatch = 'task-44444444-4444-4444-8444-444444444444';
    await mkdir(join(root, mismatch));
    await writeFile(join(root, mismatch, 'reservation.json'), JSON.stringify({ version: 1, taskId: mismatch,
      reservationId: reservation.id, reservationDigestSha256: 'b'.repeat(64), deviceId: 'device',
      flowSha256: createHash('sha256').update(JSON.stringify(flow)).digest('hex') }));
    await assert.rejects(store.createReserved(mismatch, 'device', flow, reservation), /marker|identity|match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
