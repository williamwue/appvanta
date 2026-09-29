import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bindDeviceLockRun, withDeviceLock, retainDeviceLockForCleanup } from '../packages/core/dist/index.js';
import { readEmulatorAcceleration, shakeEmulator } from '../packages/android/dist/emulator-sensors.js';
import { AdbDriver } from '../packages/android/dist/index.js';

const device = process.argv[2]; assert(device, 'Emulator serial required');
const apk = resolve(process.argv[3] ?? '.appvanta/sensor-probe/appvanta-sensor-probe.apk');
const axis = process.argv[4] ?? 'x'; assert(['x', 'y', 'z'].includes(axis));
const axisIndex = ['x', 'y', 'z'].indexOf(axis);
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
    const parseComplete = text => text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    await delay(750);
    const idleRaw = await readEvents();
    await writeFile(join(root, 'idle-events.jsonl'), idleRaw);
    const idleRecords = parseComplete(idleRaw);
    assert(idleRecords.every(record => record.session === session));
    assert(idleRecords.some(record => record.type === 'sample'), 'Detector must receive a baseline event before injection');
    assert(!idleRecords.some(record => record.type === 'shake'), 'Quiet baseline must not trigger the detector');
    const driver = new AdbDriver({ artifactsDirectory: join(root, 'application-ui') });
    const before = await driver.observe(device);
    assert.match(await readFile(before.uiTreePath, 'utf8'), /Shake detections: 0/);
    const shake = await shakeEmulator('adb', device, root, { axis, amplitude: 12, cycles: 3, intervalMs: 150 });
    await delay(200);
    const after = await driver.observe(device);
    assert.match(await readFile(after.uiTreePath, 'utf8'), /Shake detections: [1-9][0-9]*/);
    await adb('shell', 'am', 'force-stop', app); started = false;
    const raw = await readEvents(); await writeFile(join(root, 'sensor-events.jsonl'), raw);
    const records = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert(records.every(record => record.session === session));
    const samples = records.filter(record => record.type === 'sample');
    const detections = records.filter(record => record.type === 'shake');
    assert(detections.length > 0 && detections.every((record, index) => record.count === index + 1 && record.axis === axisIndex));
    assert.match(await readFile(after.uiTreePath, 'utf8'), new RegExp(`Shake detections: ${detections.length}(?:&|"|<)`));
    assert(samples.length >= 6, 'Application must receive multiple actual events');
    assert(samples.every((value, index) => Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z) && Number.isFinite(value.timestampNanos) && (!index || value.timestampNanos >= samples[index - 1].timestampNanos)));
    const minimumAxis = Math.min(...samples.map(value => value[axis])), maximumAxis = Math.max(...samples.map(value => value[axis]));
    assert(minimumAxis < original[axisIndex] - 6 && maximumAxis > original[axisIndex] + 6, 'Application must receive both shake directions');
    assert(close(await readEmulatorAcceleration('adb', device)));
    return { session, apkHash, original, axis, shake, samples: samples.length, minimumAxis, maximumAxis, detections, idleDetectionCount: 0, before, after };
  } catch (error) {
    try { assert(close(await readEmulatorAcceleration('adb', device))); }
    catch { await retainDeviceLockForCleanup(device, root); }
    throw error;
  } finally { if (started) await adb('shell', 'am', 'force-stop', app); }
});
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, ...result, limitation: 'Application callback evidence on one emulator; no claim about arbitrary app shake detectors or physical devices.' }, null, 2));
console.log(JSON.stringify({ status: 'passed', root, samples: result.samples }));
