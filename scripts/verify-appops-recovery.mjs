import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectDeviceLock, recoverDeviceLock } from '../packages/core/dist/device-lock.js';
import { recoverAppOps, parseAppOpMode } from '../packages/android/dist/appops-fixture.js';
const device = process.argv[2]; assert(device, 'Specify device');
if (process.argv.includes('--retry-cleanup')) {
  const state = await inspectDeviceLock(device);
  assert(state?.owner === 'dead' && /appops-recovery-\d+$/.test(state.lease.runDirectory ?? ''), 'Not an abandoned AppOps-only test');
  await recoverDeviceLock(device, state.lease.token, async lease => {
    assert.deepEqual(JSON.parse(await readFile(join(lease.runDirectory, 'device-lease.json'), 'utf8')), lease);
    await recoverAppOps(device, lease.runDirectory);
  });
  process.exit(0);
}
const root = resolve('.appvanta/runs', `appops-recovery-${Date.now()}`);
await mkdir(root, { recursive: true });
const pkg = 'net.gsantner.markor', operation = 'MANAGE_EXTERNAL_STORAGE';
const adb = (...args) => execFileSync('adb', ['-s', device, 'shell', 'cmd', 'appops', ...args], { encoding: 'utf8', timeout: 20000 }).trim();
const state = () => parseAppOpMode(adb('get', pkg, operation), operation);
const before = state(), requested = before === 'ignore' ? 'allow' : 'ignore';
const external = ['allow', 'ignore', 'deny'].find(mode => mode !== before && mode !== requested);
const core = pathToFileURL(resolve('packages/core/dist/device-lock.js')).href;
const fixture = pathToFileURL(resolve('packages/android/dist/appops-fixture.js')).href;
const code = `import {withDeviceLock, bindDeviceLockRun} from ${JSON.stringify(core)}; import {startAppOps} from ${JSON.stringify(fixture)}; await withDeviceLock(${JSON.stringify(device)}, async () => { await bindDeviceLockRun(${JSON.stringify(device)}, ${JSON.stringify(root)}); await startAppOps(${JSON.stringify([{ packageName: pkg, operation, mode: requested }])}, ${JSON.stringify(device)}, ${JSON.stringify(root)}); console.log('ready'); await new Promise(() => setInterval(() => {}, 1000)); });`;
const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
const exited = once(child, 'exit');
try {
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(30000) });
  assert.equal(state(), requested);
  child.kill('SIGKILL'); await exited;
  const lease = await inspectDeviceLock(device);
  assert.equal(lease.owner, 'dead');
  await recoverDeviceLock(device, lease.lease.token, async original => {
    assert.equal(original.runDirectory, root);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'device-lease.json'), 'utf8')), original);
    adb('set', pkg, operation, external);
    try {
      await assert.rejects(recoverAppOps(device, root), /restoration failed/);
      assert.equal(state(), external);
    } finally { adb('set', pkg, operation, requested); }
    await recoverAppOps(device, root);
    assert.equal(state(), before);
    await recoverAppOps(device, root);
  });
  assert.equal(await inspectDeviceLock(device), null);
  await assert.rejects(recoverAppOps('different-device', root), /unbound/);
  const audit = (await readFile(join(root, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(audit.some(item => item.action === 'restore-appop' && item.outcome === 'failed'));
  assert(audit.some(item => item.action === 'restore-appop' && item.outcome === 'passed'));
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', before, after: state(), requested, external, audit }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
