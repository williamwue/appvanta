import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorStore } from '../dist/index.js';

test('monitor records validate bounds, persist release requests and protect terminal history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-monitors-'));
  try {
    const store = new MonitorStore(root);
    await assert.rejects(store.create('device', 499, 1000), /interval/);
    const monitor = await store.create('device', 500, 1000);
    monitor.status = 'running'; monitor.sampleCount = 1; await store.save(monitor);
    assert.equal((await store.requestRelease(monitor.id)).status, 'releasing');
    assert.equal((await store.get(monitor.id)).status, 'releasing');
    monitor.status = 'released'; monitor.finishedAt = new Date().toISOString(); await store.save(monitor);
    assert.equal((await store.get(monitor.id)).status, 'released');
    monitor.error = 'rewrite'; await assert.rejects(store.save(monitor), /Terminal monitor/);
    assert.equal((await store.list()).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('queued monitor ownership transfers exactly once to an independent worker session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-monitor-transfer-'));
  const ownerSession = '11111111-1111-4111-8111-111111111111', workerSession = '22222222-2222-4222-8222-222222222222';
  try {
    const owner = new MonitorStore(root, ownerSession), worker = new MonitorStore(root, workerSession);
    const monitor = await owner.create('device', 500, 1000), transferred = await owner.transferQueued(monitor, process.pid, workerSession);
    assert.equal(transferred.owner.session, workerSession);
    await assert.rejects(owner.save(monitor), /owner changed|another worker/i);
    const claimed = await worker.get(monitor.id); claimed.status = 'running'; await worker.save(claimed);
    assert.equal((await owner.get(monitor.id)).status, 'running');
    await assert.rejects(owner.transferQueued(monitor, process.pid, workerSession), /changed|another worker/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('monitor rejects an ID directory retargeted through a symlink or junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-monitor-retarget-'));
  try {
    const store = new MonitorStore(root);
    const monitor = await store.create('device', 500, 1000);
    const monitorRoot = join(root, monitor.id), retarget = join(root, 'retarget');
    await mkdir(retarget);
    await copyFile(join(monitorRoot, 'monitor.json'), join(retarget, 'monitor.json'));
    await rm(monitorRoot, { recursive: true, force: true });
    await symlink(retarget, monitorRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.get(monitor.id), /Invalid persisted monitor/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
