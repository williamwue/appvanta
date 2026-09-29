import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bindDeviceLockRun, withDeviceLock, retainDeviceLockForCleanup } from '../packages/core/dist/index.js';
import { accelerationSequence, readEmulatorAcceleration, restoreEmulatorShake, shakeEmulator } from '../packages/android/dist/emulator-sensors.js';

const device = process.argv[2]; assert(device, 'Emulator serial required');
const root = resolve('.appvanta/runs', `emulator-shake-${Date.now()}`);
await mkdir(root, { recursive: true });
const close = (a, b) => a.every((value, index) => Math.abs(value - b[index]) <= 0.0001);
const result = await withDeviceLock(device, async () => {
  await bindDeviceLockRun(device, root);
  const original = await readEmulatorAcceleration('adb', device);
  try {
    const normal = await shakeEmulator('adb', device, root, { axis: 'x', amplitude: 12, cycles: 3, intervalMs: 100 });
    assert(close(await readEmulatorAcceleration('adb', device), original));
    const controller = new AbortController();
    const operation = shakeEmulator('adb', device, root, { axis: 'x', amplitude: 12, cycles: 10, intervalMs: 200 }, controller.signal);
    const settled = operation.then(value => ({ value }), error => ({ error }));
    let during, probeError;
    try {
      for (let index = 0; index < 30; index++) {
        during = await readEmulatorAcceleration('adb', device);
        if (!close(during, original)) break;
        await delay(50);
      }
    } catch (error) { probeError = error; }
    finally { controller.abort(new Error('Verifier cancellation after sensor update')); }
    const cancelled = await settled;
    if (probeError) throw probeError;
    assert(during && !close(during, original), 'Cancellation must occur after an observed acceleration change');
    assert(cancelled.error, 'Shake must reject cancellation');
    const restored = await readEmulatorAcceleration('adb', device);
    assert(close(restored, original));
    // This fixture owns both the injected conflict and its final cleanup under one lease.
    const conflictPath = join(root, 'external-conflict.json');
    const options = { axis: 'x', amplitude: 12, cycles: 1, intervalMs: 100 };
    const conflictRecord = JSON.stringify({ version: 1, device, original, sequence: accelerationSequence(original, options), options });
    await writeFile(conflictPath, conflictRecord, { flag: 'wx' });
    const external = [...original]; external[0] += 3;
    const exec = promisify(execFile);
    let observedConflict, conflictError;
    try {
      const update = await exec('adb', ['-s', device, 'emu', 'sensor', 'set', 'acceleration', external.join(':')], { timeout: 10000, windowsHide: true });
      assert.equal(update.stdout.trim(), 'OK');
      observedConflict = await readEmulatorAcceleration('adb', device);
      assert(close(observedConflict, external));
      await assert.rejects(restoreEmulatorShake('adb', device, conflictPath), error => {
        conflictError = String(error);
        return /changed externally/.test(conflictError);
      });
      assert(close(await readEmulatorAcceleration('adb', device), external), 'Recovery must preserve the external value');
      assert.equal(await readFile(conflictPath, 'utf8'), conflictRecord, 'Recovery must retain the original record');
      await assert.rejects(access(`${conflictPath}.restored.json`), { code: 'ENOENT' });
    } finally {
      const current = await readEmulatorAcceleration('adb', device);
      assert(close(current, external) || close(current, original), 'Fixture cleanup refuses an unrelated acceleration value');
      const cleanup = await exec('adb', ['-s', device, 'emu', 'sensor', 'set', 'acceleration', original.join(':')], { timeout: 10000, windowsHide: true });
      assert.equal(cleanup.stdout.trim(), 'OK');
      assert(close(await readEmulatorAcceleration('adb', device), original));
    }
    return { original, normal, duringCancellation: during, restored, cancellation: String(cancelled.error), conflict: { recordPath: conflictPath, observed: observedConflict, error: conflictError, preserved: true, fixtureCleanupVerified: true } };
  } catch (error) {
    try { assert(close(await readEmulatorAcceleration('adb', device), original)); }
    catch { await retainDeviceLockForCleanup(device, root); }
    throw error;
  }
});
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, ...result, limitations: ['Console readback only; application SensorEvent delivery and physical devices not verified.', 'SDK helper prototype; Flow/MCP integration and crash recovery admission are pending.'] }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
