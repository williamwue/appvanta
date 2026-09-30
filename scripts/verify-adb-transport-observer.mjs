import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withDeviceLock, inspectDeviceLock } from '../packages/core/dist/index.js';
import { observeAdbTransport } from './adb-transport-observer.mjs';

const device = process.argv[2]; assert(/^emulator-[0-9]+$/.test(device), 'Explicit emulator serial required');
const root = resolve('.appvanta/runs', `adb-transport-observer-${Date.now()}`); await mkdir(root, { recursive: true });
const adb = process.env.ADB_PATH ?? 'adb';
const run = async (...args) => (await promisify(execFile)(adb, ['-s', device, ...args], { windowsHide: true, encoding: 'utf8', timeout: 60000 })).stdout.trim();
const value = (snapshot, name) => {
  const item = snapshot.results.find(result => result.name === name); assert.equal(item.status, 'passed'); return item.stdout.trim();
};
const transport = snapshot => {
  const line = value(snapshot, 'devices').split(/\r?\n/).find(line => line.startsWith(`${device} `) || line.startsWith(`${device}\t`));
  const id = /\btransport_id:([0-9]+)\b/.exec(line ?? '')?.[1]; assert(id); return id;
};
let result;
try {
  await withDeviceLock(device, async () => {
    const fingerprint = await run('shell', 'getprop', 'ro.build.fingerprint');
    const observer = await observeAdbTransport(device, root, adb);
    try {
      const before = await observer.snapshot('before-explicit-device-reconnect');
      let reconnect;
      try { reconnect = { status: 'passed', stdout: await run('reconnect', 'device') }; }
      catch (error) { reconnect = { status: 'failed', error: String(error), stdout: error.stdout, stderr: error.stderr }; }
      await run('wait-for-device');
      const after = await observer.snapshot('after-explicit-device-reconnect', true);
      assert.equal(await run('shell', 'getprop', 'ro.build.fingerprint'), fingerprint);
      assert.equal(value(after, 'bootId'), value(before, 'bootId'));
      assert.match(value(before, 'bootId'), /^[a-f0-9-]{36}$/);
      assert.notEqual(transport(before), transport(after));
      result = { status: 'passed', scope: 'explicit-device-end-reconnect-observation', device, fingerprint, reconnect, before, after, beforeTransportId: transport(before), afterTransportId: transport(after), bootUnchanged: true };
    } finally { await observer.stop(); }
    const evidence = JSON.parse(await readFile(join(root, 'adb-transport.json'), 'utf8'));
    assert.equal(evidence.dropped, 0);
    assert(evidence.events.some(event => event.text.includes(`transport_id:${result.beforeTransportId}`)));
    assert(evidence.events.some(event => event.text.includes(`transport_id:${result.afterTransportId}`)));
    assert(evidence.finished, 'Tracker process must be closed');
  });
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(root, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), result, lease: await inspectDeviceLock(device) }, null, 2)); throw error;
}
