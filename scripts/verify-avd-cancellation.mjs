import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startAndroidAvd } from '../packages/android/dist/index.js';
import { inspectDeviceLock } from '../packages/core/dist/index.js';

const [name, serial] = process.argv.slice(2);
assert((name?.startsWith('AppVanta_') || name === 'appvanta-ci') && /^emulator-\d+$/.test(serial), 'Specify an already running AppVanta test AVD and serial');
const adb = async args => (await promisify(execFile)(process.env.ADB_PATH || 'adb', args, { encoding: 'utf8', timeout: 5000, windowsHide: true })).stdout.trim();
assert.equal((await adb(['-s', serial, 'emu', 'avd', 'name'])).split(/\r?\n/)[0].trim(), name);
assert.equal(await inspectDeviceLock(serial), null);
const bootBefore = await adb(['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']);
await mkdir('.appvanta/emulators', { recursive: true });
const before = new Set(await readdir('.appvanta/emulators'));
const controller = new AbortController();
let finished = false;
const operation = startAndroidAvd(name, Number(serial.slice(9)), 30000, undefined, controller.signal)
  .then(result => ({ result }), error => ({ error: String(error) })).finally(() => { finished = true; });
let startup;
const deadline = Date.now() + 15000;
try {
  while (!startup) {
    assert(!finished, 'Startup finished before cancellation checkpoint');
    assert(Date.now() < deadline, 'Startup checkpoint timed out');
    for (const entry of (await readdir('.appvanta/emulators')).filter(item => !before.has(item))) {
      try {
        const value = JSON.parse(await readFile(join('.appvanta/emulators', entry, 'startup.json'), 'utf8'));
        if (value.name === name && value.serial === serial && value.status === 'starting') startup = value;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    if (!startup) await delay(5);
  }
  const cancelledAt = Date.now();
  controller.abort(new Error('Verifier cancelled reused AVD startup'));
  const outcome = await operation;
  assert.match(outcome.error, /startup wait cancelled/);
  const elapsedMs = Date.now() - cancelledAt;
  assert(elapsedMs < 5000, 'Cancellation exceeded five seconds');
  const record = JSON.parse(await readFile(join(startup.directory, 'startup.json'), 'utf8'));
  assert.equal(record.status, 'cancelled'); assert.equal(record.reused, true);
  assert.equal(await inspectDeviceLock(serial), null);
  assert.equal(await inspectDeviceLock(`avd:${name}`), null);
  assert.equal(await adb(['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']), bootBefore);
  assert.equal(await adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']), '1');
  const resumed = await startAndroidAvd(name, Number(serial.slice(9)), 30000);
  assert.equal(resumed.status, 'ready'); assert.equal(resumed.reused, true);
  const root = resolve('.appvanta/runs', `avd-cancellation-${Date.now()}`); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', scope: 'SDK reused live AVD wait cancellation', record, resumed, bootBefore, elapsedMs }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, elapsedMs }));
} finally { controller.abort(); await operation; }
