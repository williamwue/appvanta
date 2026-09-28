import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectDeviceLock, recoverDeviceLock } from '../packages/core/dist/device-lock.js';
import { parsePermissionSnapshot, recoverRuntimePermissions } from '../packages/android/dist/permission-fixture.js';

const device = process.argv[2];
assert(device, 'Specify device');
const run = (...args) => execFileSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim();
run('python', 'scripts/build-input-ime.py');
run('adb', '-s', device, 'install', '-r', '.appvanta/input-ime/appvanta-input.apk');
const root = resolve('.appvanta/runs', `permission-recovery-${Date.now()}`);
await mkdir(root, { recursive: true });
const packageName = 'dev.appvanta.input', permission = 'android.permission.CAMERA';
const shell = (...args) => run('adb', '-s', device, 'shell', ...args);
const userId = Number(shell('am', 'get-current-user'));
assert(Number.isSafeInteger(userId) && userId >= 0);
const state = () => parsePermissionSnapshot(shell('dumpsys', 'package', packageName), packageName, permission, userId);
const setFlags = desired => {
  const current = state().flags;
  const removed = current.filter(flag => !desired.includes(flag)), added = desired.filter(flag => !current.includes(flag));
  if (removed.length) shell('pm', 'clear-permission-flags', '--user', String(userId), packageName, permission, ...removed);
  if (added.length) shell('pm', 'set-permission-flags', '--user', String(userId), packageName, permission, ...added);
};
const before = state(), requested = before.granted ? 'deny' : 'grant';
const core = pathToFileURL(resolve('packages/core/dist/device-lock.js')).href;
const fixture = pathToFileURL(resolve('packages/android/dist/permission-fixture.js')).href;
const code = `import {withDeviceLock, bindDeviceLockRun} from ${JSON.stringify(core)}; import {startRuntimePermissions} from ${JSON.stringify(fixture)}; await withDeviceLock(${JSON.stringify(device)}, async () => { await bindDeviceLockRun(${JSON.stringify(device)}, ${JSON.stringify(root)}); await startRuntimePermissions(${JSON.stringify([{ packageName, permission, state: requested }])}, ${JSON.stringify(device)}, ${JSON.stringify(root)}); console.log('ready'); await new Promise(() => setInterval(() => {}, 1000)); });`;
const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
const exited = once(child, 'exit');
try {
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(30000) });
  assert.equal(state().granted, requested === 'grant');
  child.kill('SIGKILL'); await exited;
  const lock = await inspectDeviceLock(device);
  assert.equal(lock.owner, 'dead');
  await recoverDeviceLock(device, lock.lease.token, async lease => {
    assert.equal(lease.runDirectory, root);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'device-lease.json'), 'utf8')), lease);
    const record = JSON.parse(await readFile(join(root, 'fixtures/permissions.json'), 'utf8'));
    const prepared = record.entries[0].prepared;
    const externalFlags = prepared.flags.includes('user-fixed') ? prepared.flags.filter(flag => flag !== 'user-fixed') : [...prepared.flags, 'user-fixed'].sort();
    setFlags(externalFlags);
    try {
      await assert.rejects(recoverRuntimePermissions(device, root), /restoration failed/);
      assert.deepEqual(state().flags, externalFlags);
    } finally { setFlags(prepared.flags); }
    await recoverRuntimePermissions(device, root);
    assert.deepEqual(state(), before);
    await recoverRuntimePermissions(device, root);
  });
  assert.equal(await inspectDeviceLock(device), null);
  await assert.rejects(recoverRuntimePermissions('different-device', root), /unbound/);
  const audit = (await readFile(join(root, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(audit.some(item => item.action === 'restore-runtime-permission' && item.outcome === 'failed'));
  assert(audit.some(item => item.action === 'restore-runtime-permission' && item.outcome === 'passed'));
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', before, after: state(), requested, audit }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
