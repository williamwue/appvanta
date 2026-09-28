import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectDeviceLock, recoverDeviceLock } from '../packages/core/dist/device-lock.js';
import { recoverImeFixture } from '../packages/android/dist/ime-fixture.js';
const device = process.argv[2]; assert(device, 'Specify device');
if (process.argv.includes('--retry-cleanup')) {
  const state = await inspectDeviceLock(device);
  assert(state?.owner === 'dead' && /ime-recovery-\d+$/.test(state.lease.runDirectory ?? ''), 'Not an abandoned IME-only test');
  await recoverDeviceLock(device, state.lease.token, async lease => {
    assert.deepEqual(JSON.parse(await readFile(join(lease.runDirectory, 'device-lease.json'), 'utf8')), lease);
    await recoverImeFixture(device, lease.runDirectory);
  });
  console.log('IME test cleanup recovered');
  process.exit(0);
}
const root = resolve('.appvanta/runs', `ime-recovery-${Date.now()}`);
await mkdir(root, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000 }).trim();
const state = () => ({ selected: adb('settings', 'get', 'secure', 'default_input_method'), enabled: adb('ime', 'list', '-s').split(/\r?\n/).filter(Boolean).sort() });
const before = state();
const component = 'dev.appvanta.input/.InputService';
const core = pathToFileURL(resolve('packages/core/dist/device-lock.js')).href;
const fixture = pathToFileURL(resolve('packages/android/dist/ime-fixture.js')).href;
const code = `import {withDeviceLock, bindDeviceLockRun} from ${JSON.stringify(core)}; import {startImeFixture} from ${JSON.stringify(fixture)}; await withDeviceLock(${JSON.stringify(device)}, async () => { await bindDeviceLockRun(${JSON.stringify(device)}, ${JSON.stringify(root)}); await startImeFixture(${JSON.stringify(component)}, ${JSON.stringify(device)}, ${JSON.stringify(root)}); console.log('ready'); await new Promise(() => setInterval(() => {}, 1000)); });`;
const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
const exited = once(child, 'exit');
try {
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(30000) });
  assert.equal(state().selected, component);
  child.kill('SIGKILL'); await exited;
  const lease = await inspectDeviceLock(device);
  assert.equal(lease.owner, 'dead');
  assert.equal(lease.lease.runDirectory, root);
  await recoverDeviceLock(device, lease.lease.token, async original => {
    assert.deepEqual(JSON.parse(await readFile(join(root, 'device-lease.json'), 'utf8')), original);
    const external = adb('ime', 'list', '-a', '-s').split(/\r?\n/).find(item => item !== component && item !== before.selected);
    assert(external, 'Need a third IME to verify external changes');
    const wasEnabled = before.enabled.includes(external);
    adb('ime', wasEnabled ? 'disable' : 'enable', external);
    const externalState = state();
    try {
      await assert.rejects(recoverImeFixture(device, root), /outside fixture/);
      assert.deepEqual(state(), externalState);
    } finally { adb('ime', wasEnabled ? 'enable' : 'disable', external); }
    // This deliberately bounded fixture process only changed IME state.
    await recoverImeFixture(device, root);
    assert.deepEqual(state(), before);
    await recoverImeFixture(device, root); // Verified retry after cleanup is idempotent.
  });
  assert.equal(await inspectDeviceLock(device), null);
  const evidence = JSON.parse(await readFile(join(root, 'fixtures/input-method.json'), 'utf8'));
  assert.equal(evidence.restored, true);
  await assert.rejects(recoverImeFixture('different-device', root), /unbound/);
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', before, after: state(), lease: lease.lease, evidence }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  // Do not force-clear a failed recovery lease; it is needed for retry.
}
