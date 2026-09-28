import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startAndroidAvd } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const name = process.argv[2], port = Number(process.argv[3] ?? 5554);
assert(name?.startsWith('AppVanta_'), 'Use an AppVanta-owned test AVD');
const adb = process.env.ADB_PATH || 'adb';
const run = async args => (await promisify(execFile)(adb, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 })).stdout;
const initial = await startAndroidAvd(name, port, 60000);
assert.equal(initial.status, 'ready');
const serial = initial.serial;
await withDeviceLock(serial, async () => {
  const current = (await run(['-s', serial, 'emu', 'avd', 'name'])).split(/\r?\n/)[0].trim();
  assert.equal(current, name);
  await run(['-s', serial, 'emu', 'kill']);
  const deadline = Date.now() + 30000;
  while ((await run(['devices'])).split(/\r?\n/).some(line => line.startsWith(serial + '\t'))) {
    assert(Date.now() < deadline, 'Test emulator did not exit'); await delay(500);
  }
});
const started = await startAndroidAvd(name, port, 120000);
assert.equal(started.status, 'ready', JSON.stringify(started));
assert.equal(started.reused, false); assert(started.pid);
assert(!started.args.includes('-wipe-data'));
const reused = await startAndroidAvd(name, port, 30000);
assert.equal(reused.status, 'ready'); assert.equal(reused.reused, true);
assert.equal(reused.serial, started.serial);
assert((await readFile(join(started.directory, 'emulator.log'))).length > 0);
const root = resolve('.appvanta/runs', `avd-start-${Date.now()}`); await mkdir(root, { recursive: true });
const verification = { status: 'passed', initial, started, reused };
await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
console.log(JSON.stringify({ ...verification, root }, null, 2));
