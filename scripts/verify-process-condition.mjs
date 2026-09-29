import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AdbDriver } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const device = process.argv[2]; assert(device, 'Device ID required');
const root = resolve('.appvanta/runs', `process-condition-${Date.now()}`);
await mkdir(root, { recursive: true });
const driver = new AdbDriver({ artifactsDirectory: root });
const condition = packageName => ({ kind: 'app-running', packageName });
const observed = await withDeviceLock(device, async () => {
  const running = await driver.checkCondition(device, condition('com.android.systemui'));
  const absent = await driver.checkCondition(device, condition(`dev.appvanta.absent.p${randomUUID().replaceAll('-', '')}`));
  assert.equal(running, true); assert.equal(absent, false);
  return { running, absent };
});
const missingDevice = `appvanta-missing-${randomUUID()}`;
let transport;
try { await driver.checkCondition(missingDevice, condition('com.android.systemui')); }
catch (error) { transport = { code: error.code, message: String(error), stderr: error.stderr }; }
assert(transport, 'Missing device must reject instead of returning false');
assert.equal(transport.code, 1);
assert.match(transport.stderr, /device.*not found/i);
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, ...observed, missingDevice, transport, limitation: 'Unknown serial exercises a real ADB transport failure, not a physical disconnect.' }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
