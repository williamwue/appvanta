import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runOnDevices, withDeviceLock } from '../dist/index.js';

test('scheduler limits concurrency, preserves all results and respects pending cancellation', async () => {
  let active = 0, peak = 0, called = 0;
  const results = await runOnDevices(['a', 'b', 'c', 'd'], async id => {
    called++; active++; peak = Math.max(peak, active);
    await delay(id === 'a' ? 20 : 2); active--;
    if (id === 'b') throw new Error('offline');
    return { status: id === 'c' ? 'failed' : 'passed' };
  }, { concurrency: 2, status: result => result.status });
  assert.equal(peak, 2); assert.equal(called, 4);
  assert.deepEqual(results.map(r => r.deviceId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(results.map(r => r.status), ['passed', 'failed', 'failed', 'passed']);
  for (const ids of [[], ['a', 'a'], ['']]) await assert.rejects(runOnDevices(ids, async () => { throw new Error('must not run'); }), /unique/);
  await assert.rejects(runOnDevices(['a'], async () => 1, { concurrency: NaN }), /Concurrency/);
  const controller = new AbortController();
  let dispatched = 0;
  const cancelled = await runOnDevices(['a', 'b', 'c'], async () => { dispatched++; controller.abort(); return 1; }, { concurrency: 1, signal: controller.signal });
  assert.equal(dispatched, 1);
  assert.deepEqual(cancelled.map(r => r.status), ['passed', 'cancelled', 'cancelled']);
});

test('device lease excludes other processes, permits nested calls and releases after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-lock-'));
  const module = new URL('../dist/device-lock.js', import.meta.url).href;
  const exec = promisify(execFile);
  try {
    await withDeviceLock('emulator:5554', async () => {
      await withDeviceLock('emulator:5554', async () => {}, root);
      await withDeviceLock('other', async () => {}, root);
      const code = `import { withDeviceLock } from ${JSON.stringify(module)}; try { await withDeviceLock('emulator:5554', async () => { console.log('unsafe'); }, process.argv[1]); } catch(e) { console.log(e.message); process.exitCode = 7; }`;
      try { await exec(process.execPath, ['--input-type=module', '-e', code, root]); assert.fail('Lease did not exclude another process'); }
      catch (error) { assert.equal(error.code, 7); assert.match(error.stdout, /Device busy/); assert(!error.stdout.includes('unsafe')); }
    }, root);
    await assert.rejects(withDeviceLock('emulator:5554', async () => { throw new Error('action failed'); }, root), /action failed/);
    await withDeviceLock('emulator:5554', async () => {}, root);
    let release, notify;
    const entered = new Promise(done => { notify = done; });
    const gate = new Promise(done => { release = done; });
    const holding = withDeviceLock('shared', async () => { notify(); await gate; }, root);
    await entered;
    try { await assert.rejects(withDeviceLock('shared', async () => {}, root), /Device busy/); }
    finally { release(); await holding; }
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
