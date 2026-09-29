import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bindDeviceLockRun, withDeviceLock, retainDeviceLockForCleanup } from '../packages/core/dist/index.js';
import { readEmulatorAcceleration, shakeEmulator } from '../packages/android/dist/emulator-sensors.js';

const device = process.argv[2]; assert(device, 'Emulator serial required');
const apk = resolve(process.argv[3] ?? '.appvanta/sensor-probe/appvanta-sensor-probe.apk');
const apkHash = createHash('sha256').update(await readFile(apk)).digest('hex');
const root = resolve('.appvanta/runs', `sensor-events-${Date.now()}`);
await mkdir(root, { recursive: true });
const adb = async (...args) => (await promisify(execFile)('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true })).stdout;
const session = randomUUID(), app = 'dev.appvanta.sensorprobe';
const result = await withDeviceLock(device, async () => {
  await bindDeviceLockRun(device, root);
  const original = await readEmulatorAcceleration('adb', device);
  const close = value => value.every((axis, index) => Math.abs(axis - original[index]) <= 0.0001);
  let started = false;
  try {
    await adb('install', '-r', apk);
    await adb('shell', 'am', 'start', '-W', '-n', `${app}/.SensorActivity`, '--es', 'session', session); started = true;
    const readEvents = () => adb('shell', 'run-as', app, 'cat', `files/events-${session}.jsonl`);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      let text;
      try { text = await readEvents(); }
      catch (error) {
        if (!/No such file or directory/.test(String(error.stderr))) throw error;
        await delay(100); continue;
      }
      const complete = text.slice(0, text.lastIndexOf('\n') + 1);
      ready = complete.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).some(record => record.session === session && record.type === 'ready' && record.registered === true);
      if (ready) break;
      await delay(100);
    }
    assert(ready, 'Application must register the accelerometer');
    const shake = await shakeEmulator('adb', device, root, { axis: 'x', amplitude: 12, cycles: 3, intervalMs: 150 });
    await delay(200);
    await adb('shell', 'am', 'force-stop', app); started = false;
    const raw = await readEvents(); await writeFile(join(root, 'sensor-events.jsonl'), raw);
    const records = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert(records.every(record => record.session === session));
    const samples = records.filter(record => record.type === 'sample');
    assert(samples.length >= 6, 'Application must receive multiple actual events');
    assert(samples.every((value, index) => Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) && Number.isFinite(value.timestampNanos) && (!index || value.timestampNanos >= samples[index - 1].timestampNanos)));
    const minimumX = Math.min(...samples.map(value => value.x)), maximumX = Math.max(...samples.map(value => value.x));
    assert(minimumX < original[0] - 6 && maximumX > original[0] + 6, 'Application must receive both shake directions');
    assert(close(await readEmulatorAcceleration('adb', device)));
    return { session, apkHash, original, shake, samples: samples.length, minimumX, maximumX };
  } catch (error) {
    try { assert(close(await readEmulatorAcceleration('adb', device))); }
    catch { await retainDeviceLockForCleanup(device, root); }
    throw error;
  } finally { if (started) await adb('shell', 'am', 'force-stop', app); }
});
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, ...result, limitation: 'Application callback evidence on one emulator; no claim about arbitrary app shake detectors or physical devices.' }, null, 2));
console.log(JSON.stringify({ status: 'passed', root, samples: result.samples }));
