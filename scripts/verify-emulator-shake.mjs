import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bindDeviceLockRun, withDeviceLock, retainDeviceLockForCleanup } from '../packages/core/dist/index.js';
import { readEmulatorAcceleration, shakeEmulator } from '../packages/android/dist/emulator-sensors.js';

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
    return { original, normal, duringCancellation: during, restored, cancellation: String(cancelled.error) };
  } catch (error) {
    try { assert(close(await readEmulatorAcceleration('adb', device), original)); }
    catch { await retainDeviceLockForCleanup(device, root); }
    throw error;
  }
});
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, ...result, limitations: ['Console readback only; application SensorEvent delivery and physical devices not verified.', 'SDK helper prototype; Flow/MCP integration and crash recovery admission are pending.'] }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
