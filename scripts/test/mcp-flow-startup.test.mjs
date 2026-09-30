import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectStartingDeviceLease } from '../mcp-flow-startup.mjs';
import { inspectDeviceLock } from '../../packages/core/dist/index.js';

test('startup inspection distinguishes incomplete publication from an absent or complete lease', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appvanta-startup-lease-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deviceId = 'startup-fixture';
  const path = join(directory, createHash('sha256').update(deviceId).digest('hex') + '.json');
  assert.deepEqual(await inspectStartingDeviceLease(deviceId, directory), { status: 'absent' });
  for (const fragment of ['', '{"version":1,']) {
    await writeFile(path, fragment);
    await assert.rejects(inspectDeviceLock(deviceId, directory), SyntaxError);
    assert.deepEqual(await inspectStartingDeviceLease(deviceId, directory), { status: 'incomplete' });
    assert.equal(await readFile(path, 'utf8'), fragment);
  }
  const lease = { version: 1, token: randomUUID(), deviceId, pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(lease));
  const result = await inspectStartingDeviceLease(deviceId, directory);
  assert.equal(result.status, 'ready'); assert.equal(result.state.owner, 'alive');
  assert.deepEqual(result.state.lease, lease);
  await writeFile(path, '{}');
  await assert.rejects(inspectStartingDeviceLease(deviceId, directory), /Invalid/);
  assert.equal(await readFile(path, 'utf8'), '{}');
});
