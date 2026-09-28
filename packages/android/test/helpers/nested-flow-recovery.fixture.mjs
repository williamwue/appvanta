import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scenario = process.argv[2];
const calls = [];
let proxyChanged = false;
let denyUpgrade = false;
let upgradeDenied = false;
let denyCallbackMarker = false;
let callbackMarkerDenied = false;
mock.module('node:fs/promises', { namedExports: {
  ...fs,
  writeFile: async (...args) => {
    if (denyCallbackMarker && (String(args[0]).endsWith('pre-flow-failure.json')
      || String(args[1]).includes('callback persistence failed after external effect'))) {
      callbackMarkerDenied = true;
      throw Object.assign(new Error('injected callback marker EACCES'), { code: 'EACCES' });
    }
    if (denyUpgrade && String(args[0]).endsWith('.tmp')) {
      upgradeDenied = true;
      throw Object.assign(new Error('injected nested marker EACCES'), { code: 'EACCES' });
    }
    return fs.writeFile(...args);
  },
} });
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  execFile: (_file, args, _options, callback) => {
    const command = args.join(' ');
    calls.push(command);
    const changesProxy = command === '-s device shell settings put global http_proxy 127.0.0.1:8080';
    if (changesProxy) proxyChanged = true;
    const output = args[0] === 'devices' ? 'List of devices attached\ndevice\tdevice model:fake\n'
      : args[0] === 'version' ? 'Android Debug Bridge version 1.0.41\n'
      : args.at(-1) === 'ro.product.model' ? 'fake\n'
      : args.at(-1) === 'ro.build.fingerprint' ? 'fake-build\n'
      : args.includes('screencap') ? Buffer.from('fake screenshot')
      : args.includes('uiautomator') ? '<hierarchy rotation="0"/>'
      : changesProxy ? ''
      : null;
    queueMicrotask(() => output === null ? callback(new Error(`unexpected device command: ${command}`)) : callback(null, { stdout: output, stderr: '' }));
  },
} });

const { runAndroidFlow } = await import('../../dist/flow.js');
const { recoverAndroidFlow } = await import('../../dist/recover-flow.js');
const { inspectDeviceLock, retainDeviceLockForCleanup, withDeviceLock } = await import('../../../core/dist/index.js');
const { execFile } = await import('node:child_process');
const locks = join(process.cwd(), 'locks');
process.env.APPVANTA_LOCK_DIRECTORY = locks;
if (scenario === 'unbound-nested-unsafe') {
  await assert.rejects(withDeviceLock('device', async () => {
    await assert.rejects(withDeviceLock('device', async () => {
      await promisify(execFile)('adb', ['-s', 'device', 'shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:8080'], { encoding: 'utf8' });
      throw new Error('unbound proxy restoration unverified');
    }, locks), /unbound proxy restoration unverified/);
  }, locks), /remains exclusive/);
  const state = await inspectDeviceLock('device', locks);
  assert.equal(state.lease.runDirectory, undefined);
  const beforeRecovery = calls.length;
  await assert.rejects(recoverAndroidFlow('device', state.lease.token), { code: 'APPVANTA_MANUAL_RECOVERY_REQUIRED' });
  assert.equal(calls.length, beforeRecovery);
  assert.equal((await inspectDeviceLock('device', locks)).lease.token, state.lease.token);
  assert.equal(proxyChanged, true);
  assert.match(await fs.readFile(join(locks, 'audit.jsonl'), 'utf8'), /admission journal.*unresolved/);
  console.log(`${scenario}: passed`);
} else {
let run;
const input = { name: 'nested recovery guard', steps: [{ description: 'note', echo: 'ok' }] };
const flowWork = runAndroidFlow('device', input, undefined, async root => {
  run = root;
  if (scenario === 'callback-marker-denied') {
    await fs.writeFile(join(root, 'flow.json'), JSON.stringify(input));
    await promisify(execFile)('adb', ['-s', 'device', 'shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:8080'], { encoding: 'utf8' });
    denyCallbackMarker = true;
    throw new Error('callback persistence failed after external effect');
  } else if (scenario === 'nested-unsafe') {
    await assert.rejects(withDeviceLock('device', async () => {
      await promisify(execFile)('adb', ['-s', 'device', 'shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:8080'], { encoding: 'utf8' });
      throw Object.assign(new Error('proxy restoration unverified'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
    }, locks), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
  } else if (scenario === 'marker-upgrade-denied') {
    let releaseNested;
    let nestedEntered;
    const nestedGate = new Promise(resolve => { releaseNested = resolve; });
    const ready = new Promise(resolve => { nestedEntered = resolve; });
    const nested = withDeviceLock('device', async () => {
      nestedEntered();
      await nestedGate;
      await promisify(execFile)('adb', ['-s', 'device', 'shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:8080'], { encoding: 'utf8' });
      throw new Error('proxy restoration unverified');
    }, locks);
    await ready;
    await retainDeviceLockForCleanup('device', root, locks);
    denyUpgrade = true;
    releaseNested();
    await assert.rejects(nested, /proxy restoration unverified/);
  } else {
    if (scenario === 'verified-nested-flow') await withDeviceLock('device', async () => {}, locks);
    await retainDeviceLockForCleanup('device', root, locks);
  }
});
const result = scenario === 'marker-upgrade-denied' || scenario === 'callback-marker-denied' ? await assert.rejects(flowWork, scenario === 'marker-upgrade-denied' ? /remains exclusive/ : /pre-Flow failure evidence both failed/) : await flowWork;
if (result) {
  assert.equal(result.status, 'passed');
  assert.equal(result.cleanupFailed, false);
}
assert.equal(JSON.parse(await fs.readFile(join(run, 'flow.json'), 'utf8')).name, 'nested recovery guard');
let state = await inspectDeviceLock('device', locks);
assert.equal(state.lease.cleanupRequired.reason, scenario === 'nested-unsafe' ? 'nested-exit' : scenario === 'callback-marker-denied' ? 'operation-exit' : 'explicit');
const journal = join(locks, `${createHash('sha256').update('device').digest('hex')}.json.admission-${state.lease.token}.jsonl`);
if (scenario === 'journal-missing') await fs.rm(journal);
if (scenario === 'journal-corrupt') await fs.writeFile(journal, '{broken\n');
if (scenario === 'journal-truncated') await fs.writeFile(journal, (await fs.readFile(journal, 'utf8')).trimEnd());
if (scenario === 'journal-foreign' || scenario === 'journal-out-of-order') {
  const lines = (await fs.readFile(journal, 'utf8')).trimEnd().split('\n');
  const first = JSON.parse(lines[0]);
  if (scenario === 'journal-foreign') first.token = '00000000-0000-4000-8000-000000000000';
  else first.sequence = 1;
  lines[0] = JSON.stringify(first);
  await fs.writeFile(journal, lines.join('\n') + '\n');
}
if (scenario === 'legacy-version-1') {
  const leasePath = join(locks, `${createHash('sha256').update('device').digest('hex')}.json`);
  await fs.writeFile(leasePath, JSON.stringify({ ...state.lease, version: 1 }));
  await fs.writeFile(join(run, 'device-lease.json'), JSON.stringify({ ...JSON.parse(await fs.readFile(join(run, 'device-lease.json'), 'utf8')), version: 1 }));
  state = await inspectDeviceLock('device', locks);
}
const beforeRecovery = calls.length;
if (scenario === 'nested-unsafe' || scenario === 'marker-upgrade-denied' || scenario === 'callback-marker-denied' || scenario.startsWith('journal-')) {
  await assert.rejects(recoverAndroidFlow('device', state.lease.token), { code: 'APPVANTA_MANUAL_RECOVERY_REQUIRED' });
  assert.equal(calls.length, beforeRecovery, 'unsafe nested recovery must not issue device commands');
  assert.equal((await inspectDeviceLock('device', locks)).lease.token, state.lease.token);
  assert.equal(proxyChanged, scenario === 'nested-unsafe' || scenario === 'marker-upgrade-denied' || scenario === 'callback-marker-denied');
  const audit = (await fs.readFile(join(run, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(audit.some(event => event.action === 'recover-flow' && event.outcome === 'failed' && /(nested|onRunCreated)/.test(event.metadata.reason)));
  if (scenario === 'marker-upgrade-denied') assert.equal(upgradeDenied, true);
  if (scenario === 'callback-marker-denied') {
    assert.equal(callbackMarkerDenied, true);
    await assert.rejects(fs.readFile(join(run, 'pre-flow-failure.json')), { code: 'ENOENT' });
  }
} else {
  const recovered = await recoverAndroidFlow('device', state.lease.token);
  assert.equal(recovered.scope, 'environment-cleanup');
  assert.equal(await inspectDeviceLock('device', locks), null);
  assert.equal(calls.length, beforeRecovery + 3, 'verified Flow recovery checks connected device identity');
  assert.equal(proxyChanged, false);
}
console.log(`${scenario}: passed`);
}
