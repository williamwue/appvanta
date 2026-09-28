import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { archiveCancelledContinuation } from '../dist/retry-continuation.js';

test('retry rejects changed identity, living owner and successor; preserves archived evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-retry-')), directory = join(root, 'continuation');
  await mkdir(directory);
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); assert.equal(child.status, 0);
  const claim = { id: 'claim', sourceTaskId: 'task', deviceId: 'device', owner: { host: hostname(), pid: child.pid } };
  const cancelled = { version: 1, phase: 'cleanup-complete-before-transfer', claimId: 'claim', taskId: 'task', leaseToken: 'token' };
  const save = (name, value) => writeFile(join(directory, name), JSON.stringify(value));
  try {
    assert.equal(await archiveCancelledContinuation(directory, 'task', 'device', 'token'), undefined);
    await save('claim.json', claim); await save('cancelled-before-transfer.json', cancelled);
    await assert.rejects(archiveCancelledContinuation(directory, 'task', 'device', 'other'), /match/);
    await save('claim.json', { ...claim, owner: { host: hostname(), pid: process.pid } });
    await assert.rejects(archiveCancelledContinuation(directory, 'task', 'device', 'token'), /alive/);
    await save('claim.json', claim); await save('successor.json', {});
    await assert.rejects(archiveCancelledContinuation(directory, 'task', 'device', 'token'), /successor/);
    await rm(join(directory, 'successor.json'));
    const archived = await archiveCancelledContinuation(directory, 'task', 'device', 'token');
    assert.deepEqual(JSON.parse(await readFile(join(archived, 'claim.json'), 'utf8')), claim);
    assert.deepEqual(JSON.parse(await readFile(join(archived, 'cancelled-before-transfer.json'), 'utf8')), cancelled);
    await assert.rejects(readFile(join(directory, 'claim.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
