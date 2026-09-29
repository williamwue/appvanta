import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { bindDeviceLockRun, inspectDeviceLock, inspectDeviceAdmissionJournal, recoverDeviceLock, continueRecoveredDevice, retainDeviceLockForCleanup, withDeviceLock, withDeviceLockAdmission } from '../dist/device-lock.js';
import { createRunContext, executeFlow, parseFlow } from '../dist/index.js';
import { withAndroidFlowDeviceLock, inspectInterruptedAndroidFlowAdmission } from '../dist/device-lock.js';

test('Android Flow admission is distinct and unresolved work still retains ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-flow-admission-'));
  const run = join(root, 'run'); await mkdir(run);
  try {
    await withDeviceLock('device', async () => {
      await assert.rejects(withAndroidFlowDeviceLock('device', async () => {
        await bindDeviceLockRun('device', run, root, 'android-flow');
        const state = await inspectDeviceLock('device', root);
        assert.equal(await inspectDeviceAdmissionJournal(state.lease, root), 'unresolved');
        const path = join(root, createHash('sha256').update('device').digest('hex') + '.json.admission-' + state.lease.token + '.jsonl');
        const entries = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(entries[1].operation, 'android-flow');
        const bound = await inspectInterruptedAndroidFlowAdmission(state.lease, root);
        assert.equal(bound.admissionId, entries[1].id);
        assert.equal(bound.runDirectory, await realpath(run));
        assert.match(bound.journalDigestSha256, /^[a-f0-9]{64}$/);
        throw new Error('unfinished flow');
      }, root), /unfinished flow/);
    }, root);
    const state = await inspectDeviceLock('device', root);
    assert.equal(state.lease.cleanupRequired.reason, 'nested-exit');
    assert.equal(await inspectDeviceAdmissionJournal(state.lease, root), 'unresolved');
    await inspectInterruptedAndroidFlowAdmission(state.lease, root);
    const bindingPath = join(run, 'device-flow-admission.json');
    const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
    await writeFile(bindingPath, JSON.stringify({ ...binding, admissionId: randomUUID() }));
    await assert.rejects(inspectInterruptedAndroidFlowAdmission(state.lease, root), /binding mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ['transfer-predecessor-write-failure', 'transfer-predecessor-sync-failure', 'transfer-init-write-failure', 'transfer-init-sync-failure', 'transfer-journal-before-publication', 'admitted-nested', 'closing-admission', 'delayed-inspection', 'delayed-inspection-no-replacement', 'marker-write-failure', 'pending-write-denied', 'resolution-write-denied', 'resolution-sync-denied', 'delayed-admission-finalization', 'recovery-unlink-retry', 'normal-unlink-retry']) {
  test(`lease interleaving: ${scenario}`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/lease-interleavings.fixture.mjs', import.meta.url)), scenario], { timeout: 15000, windowsHide: true });
    assert.match(stdout, new RegExp(`${scenario}: passed`));
  });
}

test('bound business failure with verified cleanup releases its lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-clean-business-failure-'));
  const locks = join(root, 'locks');
  const driver = { name: 'fake', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), execute: async () => ({ success: false, message: 'action rejected' }), checkCondition: async () => true };
  const device = { id: 'device', name: 'device', platform: 'android', status: 'online', capabilities: [] };
  try {
    await withDeviceLock('device', async () => {
      const context = await createRunContext({ runsDirectory: join(root, 'runs'), driver, device });
      await bindDeviceLockRun('device', context.rootDirectory, locks, 'android-flow');
      const result = await executeFlow({ context, driver, flow: parseFlow({ name: 'business failure', steps: [{ description: 'act', action: { kind: 'back' } }] }) });
      assert.equal(result.status, 'failed');
      assert.equal(result.cleanupFailed, false);
    }, locks);
    assert.equal(await inspectDeviceLock('device', locks), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('caught nested rejection retains a bound lease after the outer operation resolves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-nested-failure-'));
  const run = join(root, 'run');
  await mkdir(run);
  try {
    let releaseNested, nestedReady, outerResolved;
    const gate = new Promise(resolve => { releaseNested = resolve; });
    const ready = new Promise(resolve => { nestedReady = resolve; });
    const callbackDone = new Promise(resolve => { outerResolved = resolve; });
    let caught;
    const outer = withDeviceLock('device', async () => {
      caught = withDeviceLock('device', async () => {
        await bindDeviceLockRun('device', run, root);
        nestedReady();
        await gate;
        throw Object.assign(new Error('remote cleanup unverified'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
      }, root).catch(error => error);
      await ready;
      outerResolved();
    }, root);
    await callbackDone;
    releaseNested();
    await outer;
    assert.equal((await caught).code, 'APPVANTA_RESTORATION_UNVERIFIED');
    const state = await inspectDeviceLock('device', root);
    assert.equal(state.lease.cleanupRequired.runDirectory, await realpath(run));
    await recoverDeviceLock('device', state.lease.token, async () => {}, root);
    await withDeviceLock('device', async () => {
      await assert.rejects(withDeviceLock('device', async () => { throw new Error('ordinary setup failure'); }, root));
    }, root).catch(error => assert.match(String(error), /remains exclusive/));
    const unbound = await inspectDeviceLock('device', root);
    assert.equal(unbound.lease.runDirectory, undefined);
    await recoverDeviceLock('device', unbound.lease.token, async () => {}, root);
    assert.equal(await inspectDeviceLock('device', root), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('caught admitted callback failure retains an unbound lease and unresolved journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-callback-admission-'));
  try {
    await assert.rejects(withDeviceLock('device', async () => {
      await assert.rejects(withDeviceLockAdmission('device', async () => { throw new Error('metadata commit failed'); }, root), /metadata commit failed/);
    }, root), /remains exclusive/);
    const state = await inspectDeviceLock('device', root);
    assert.equal(state.lease.runDirectory, undefined);
    assert.equal(await inspectDeviceAdmissionJournal(state.lease, root), 'unresolved');
    await recoverDeviceLock('device', state.lease.token, async () => {}, root);
    assert.equal(await inspectDeviceLock('device', root), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nested failure upgrades an existing explicit cleanup marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-nested-marker-upgrade-'));
  const run = join(root, 'run');
  await mkdir(run);
  try {
    await withDeviceLock('device', async () => {
      await bindDeviceLockRun('device', run, root);
      let releaseNested, nestedStarted;
      const gate = new Promise(resolve => { releaseNested = resolve; });
      const started = new Promise(resolve => { nestedStarted = resolve; });
      const nested = withDeviceLock('device', async () => {
        nestedStarted();
        await gate;
        throw Object.assign(new Error('unsafe nested cleanup'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
      }, root).catch(error => error);
      await started;
      await retainDeviceLockForCleanup('device', run, root);
      assert.equal((await inspectDeviceLock('device', root)).lease.cleanupRequired.reason, 'explicit');
      releaseNested();
      assert.equal((await nested).code, 'APPVANTA_RESTORATION_UNVERIFIED');
    }, root);
    const state = await inspectDeviceLock('device', root);
    assert.equal(state.lease.cleanupRequired.reason, 'nested-exit');
    const journal = (await readFile(join(run, 'device-lease-recovery.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(journal.map(event => event.reason), ['explicit', 'nested-exit']);
    await recoverDeviceLock('device', state.lease.token, async () => {}, root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup rollback failure retains lease while ordinary setup failure releases it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-setup-rollback-'));
  const locks = join(root, 'locks');
  const driver = { name: 'fake', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), execute: async () => ({ success: true }), checkCondition: async () => true };
  const device = { id: 'device', name: 'device', platform: 'android', status: 'online', capabilities: [] };
  const flow = parseFlow({ name: 'fixture', appOps: [{ packageName: 'app.test', operation: 'CAMERA', mode: 'allow' }], steps: [{ description: 'note', echo: 'ok' }] });
  try {
    await withDeviceLock('device', async () => {
      const context = await createRunContext({ runsDirectory: join(root, 'runs'), driver, device });
      await bindDeviceLockRun('device', context.rootDirectory, locks, 'android-flow');
      const result = await executeFlow({ context, driver, flow, startAppOps: async () => { throw Object.assign(new AggregateError([new Error('setup'), new Error('rollback')]), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); } });
      assert.equal(result.cleanupFailed, true);
      await retainDeviceLockForCleanup('device', result.runDirectory, locks);
    }, locks);
    const state = await inspectDeviceLock('device', locks);
    assert(state.lease.cleanupRequired);
    await assert.rejects(recoverDeviceLock('device', state.lease.token, async () => { throw new Error('still unsafe'); }, locks), /still unsafe/);
    await recoverDeviceLock('device', state.lease.token, async () => {}, locks);
    assert.equal(await inspectDeviceLock('device', locks), null);
    await withDeviceLock('device', async () => {
      const context = await createRunContext({ runsDirectory: join(root, 'runs'), driver, device });
      await bindDeviceLockRun('device', context.rootDirectory, locks, 'android-flow');
      const result = await executeFlow({ context, driver, flow, startAppOps: async () => { throw new Error('clean setup failure'); } });
      assert.equal(result.cleanupFailed, false);
      assert.equal(result.status, 'failed');
    }, locks);
    assert.equal(await inspectDeviceLock('device', locks), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale async scope cannot bypass a released or another owner lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-stale-scope-'));
  let trigger, completed;
  const gate = new Promise(resolve => { trigger = resolve; });
  const observed = new Promise(resolve => { completed = resolve; });
  try {
    await withDeviceLock('device', async () => {
      void gate.then(async () => {
        try { await withDeviceLock('device', async () => 'stale-owner', root); completed('acquired'); }
        catch (error) { completed(String(error)); }
      });
    }, root);
    await withDeviceLock('device', async () => {
      trigger();
      assert.match(await observed, /Device busy/);
    }, root);
    assert.equal(await inspectDeviceLock('device', root), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale scope after verified recovery acquires a fresh lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-stale-recovery-'));
  const run = join(root, 'run'); await mkdir(run);
  let trigger, completed;
  const gate = new Promise(resolve => { trigger = resolve; });
  const observed = new Promise(resolve => { completed = resolve; });
  try {
    await withDeviceLock('device', async () => {
      await bindDeviceLockRun('device', run, root);
      await retainDeviceLockForCleanup('device', run, root);
      void gate.then(async () => {
        try { completed(await withDeviceLock('device', async () => (await inspectDeviceLock('device', root)).lease.token, root)); }
        catch (error) { completed(String(error)); }
      });
    }, root);
    const old = (await inspectDeviceLock('device', root)).lease.token;
    await recoverDeviceLock('device', old, async () => {}, root);
    trigger();
    assert.notEqual(await observed, old);
    assert.equal(await inspectDeviceLock('device', root), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bound exceptional exit records cleanup marker and failed evidence append stays recoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-bound-exception-'));
  const locks = join(root, 'locks');
  const run = join(root, 'run');
  await mkdir(run);
  try {
    await assert.rejects(withDeviceLock('device', async () => {
      await bindDeviceLockRun('device', run, locks);
      throw new Error('callback failed');
    }, locks), /callback failed/);
    let state = await inspectDeviceLock('device', locks);
    assert(state.lease.cleanupRequired);
    assert.match(await readFile(join(run, 'device-lease-recovery.jsonl'), 'utf8'), /cleanup-required/);
    await recoverDeviceLock('device', state.lease.token, async () => {}, locks);
    await assert.rejects(withDeviceLock('device', async () => {
      // A fresh run is required for binding, so replace the old immutable evidence path.
      const next = join(root, 'next-run'); await mkdir(next);
      await mkdir(join(next, 'device-lease-recovery.jsonl'));
      await bindDeviceLockRun('device', next, locks);
      throw new Error('callback failed again');
    }, locks), /remains exclusive/);
    state = await inspectDeviceLock('device', locks);
    assert(state.lease.cleanupRequired);
    await assert.rejects(recoverDeviceLock('device', state.lease.token, async () => {}, locks), /EISDIR|EPERM|EACCES/);
    assert.equal((await inspectDeviceLock('device', locks)).lease.token, state.lease.token);
    await rm(join(state.lease.runDirectory, 'device-lease-recovery.jsonl'), { recursive: true });
    await recoverDeviceLock('device', state.lease.token, async () => {}, locks);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed Flow finalization retains nested live lease until guarded owner recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-live-cleanup-'));
  const locks = join(root, 'locks');
  const driver = { name: 'fake', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), execute: async () => ({ success: true }), checkCondition: async () => true };
  const device = { id: 'device', name: 'device', platform: 'android', status: 'online', capabilities: [] };
  let token, runDirectory;
  try {
    await withDeviceLock('device', async () => {
      const result = await withDeviceLock('device', async () => {
        const context = await createRunContext({ runsDirectory: join(root, 'runs'), driver, device });
        await bindDeviceLockRun('device', context.rootDirectory, locks, 'android-flow');
        const result = await executeFlow({ context, driver, flow: parseFlow({ name: 'cleanup', network: { python: 'python', mitmdump: 'proxy' }, steps: [{ description: 'act', action: { kind: 'back' } }] }), startNetwork: async () => ({ stop: async () => { throw new Error('restore deadline exhausted'); } }) });
        assert.equal(result.status, 'failed');
        assert.equal(result.cleanupFailed, true);
        assert.equal(result.steps.at(-1).description, 'Finalize network capture');
        await retainDeviceLockForCleanup('device', result.runDirectory, locks);
        return result;
      }, locks);
      const state = await inspectDeviceLock('device', locks);
      token = state.lease.token;
      runDirectory = result.runDirectory;
      assert.equal(state.lease.runDirectory, await realpath(result.runDirectory));
      assert.equal(state.lease.cleanupRequired.runDirectory, state.lease.runDirectory);
      assert.equal(JSON.parse(await readFile(join(result.runDirectory, 'run.json'), 'utf8')).status, 'failed');
      assert.match(await readFile(join(result.runDirectory, 'steps.jsonl'), 'utf8'), /Finalize network capture/);
      await assert.rejects(withDeviceLock('device', async () => assert.fail('must not claim'), locks), /cleanup required/);
      await assert.rejects(recoverDeviceLock('device', token, async () => assert.fail('active operation'), locks), /alive/);
    }, locks);
    assert.equal((await inspectDeviceLock('device', locks)).lease.token, token);
    await assert.rejects(withDeviceLock('device', async () => assert.fail('must not claim'), locks), /busy/);
    await assert.rejects(recoverDeviceLock('device', token, async () => { throw new Error('verification failed'); }, locks), /verification failed/);
    assert.equal((await inspectDeviceLock('device', locks)).lease.token, token);
    await recoverDeviceLock('device', token, async lease => {
      assert.equal(lease.cleanupRequired.runDirectory, lease.runDirectory);
      assert(Object.isFrozen(lease));
      await assert.rejects(withDeviceLock('device', async () => assert.fail('must not claim'), locks), /busy/);
    }, locks);
    assert.equal(await inspectDeviceLock('device', locks), null);
    const events = (await readFile(join(runDirectory, 'device-lease-recovery.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(event => event.status), ['cleanup-required', 'verified-cleanup']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovered continuation atomically owns the device and binds a new run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-handoff-'));
  const module = new URL('../dist/device-lock.js', import.meta.url).href;
  const code = `import { withDeviceLock } from ${JSON.stringify(module)}; await withDeviceLock('handoff', async () => { process.send('ready'); await new Promise(() => setInterval(() => {}, 1000)); }, process.argv[1]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGKILL'); await exited;
    const old = (await inspectDeviceLock('handoff', root)).lease;
    await assert.rejects(continueRecoveredDevice('handoff', old.token, async () => { throw new Error('cleanup failed'); }, async () => assert.fail('must not continue'), root), /cleanup failed/);
    assert.equal((await inspectDeviceLock('handoff', root)).lease.token, old.token);
    await mkdir(join(root, 'new-run'));
    const result = await continueRecoveredDevice('handoff', old.token, async () => {
      await assert.rejects(withDeviceLock('handoff', async () => {}, root), /busy/);
    }, async () => {
      const current = await inspectDeviceLock('handoff', root);
      assert.equal(current.owner, 'alive');
      assert.notEqual(current.lease.token, old.token);
      assert.equal(current.lease.recoveredFrom.token, old.token);
      await withDeviceLock('handoff', async () => bindDeviceLockRun('handoff', join(root, 'new-run'), root), root);
      assert.equal((await inspectDeviceLock('handoff', root)).lease.runDirectory, await realpath(join(root, 'new-run')));
      return 'continued';
    }, root);
    assert.equal(result, 'continued');
    assert.equal(await inspectDeviceLock('handoff', root), null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('pre-bind continuation failure retains the transferred source run for guarded recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-handoff-prebind-'));
  const module = new URL('../dist/device-lock.js', import.meta.url).href;
  const run = join(root, 'source-run'); await mkdir(run);
  const code = `import { withDeviceLock, bindDeviceLockRun } from ${JSON.stringify(module)}; await withDeviceLock('prebind', async () => { await bindDeviceLockRun('prebind', process.argv[2], process.argv[1]); process.send('ready'); await new Promise(() => setInterval(() => {}, 1000)); }, process.argv[1]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, run], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10000) }); child.kill('SIGKILL'); await exited;
    const old = (await inspectDeviceLock('prebind', root)).lease;
    await assert.rejects(continueRecoveredDevice('prebind', old.token, async () => {}, async () => { throw new Error('startup failed'); }, root), /startup failed/);
    const state = await inspectDeviceLock('prebind', root);
    assert.equal(state.owner, 'alive');
    assert.equal(state.lease.runDirectory, await realpath(run));
    assert.equal(state.lease.cleanupRequired.runDirectory, await realpath(run));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('continued operation can retain cleanup and its live owner can recover after completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-continued-cleanup-'));
  const module = new URL('../dist/device-lock.js', import.meta.url).href;
  const code = `import { withDeviceLock } from ${JSON.stringify(module)}; await withDeviceLock('device', async () => { process.send('ready'); await new Promise(() => setInterval(() => {}, 1000)); }, process.argv[1]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGKILL'); await exited;
    const old = (await inspectDeviceLock('device', root)).lease;
    const run = join(root, 'continued-run'); await mkdir(run);
    await continueRecoveredDevice('device', old.token, async () => {}, async () => {
      await bindDeviceLockRun('device', run, root);
      await retainDeviceLockForCleanup('device', run, root);
    }, root);
    const state = await inspectDeviceLock('device', root);
    assert.equal(state.lease.cleanupRequired.runDirectory, await realpath(run));
    await assert.rejects(recoverDeviceLock('device', state.lease.token, async () => { throw new Error('not verified'); }, root), /not verified/);
    await recoverDeviceLock('device', state.lease.token, async () => {}, root);
    assert.equal(await inspectDeviceLock('device', root), null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('run binding requires owning scope and preserves matching evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-binding-'));
  const locks = join(root, 'locks'), run = join(root, 'run');
  await mkdir(run);
  try {
    await assert.rejects(bindDeviceLockRun('device', run, locks), /not held/);
    await withDeviceLock('device', async () => {
      await bindDeviceLockRun('device', run, locks);
      const state = await inspectDeviceLock('device', locks);
      assert.equal(state.lease.runDirectory, await realpath(run));
      const copy = JSON.parse(await readFile(join(run, 'device-lease.json'), 'utf8'));
      assert.deepEqual(copy, state.lease);
      await assert.rejects(bindDeviceLockRun('device', run, locks), /already/);
    }, locks);
    assert.equal(await inspectDeviceLock('device', locks), null);
    assert.equal(JSON.parse(await readFile(join(run, 'device-lease.json'), 'utf8')).deviceId, 'device');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('abandoned lease recovery excludes workers, retains failed cleanup and releases verified cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-recovery-'));
  await mkdir(join(root, 'run'));
  const module = new URL('../dist/device-lock.js', import.meta.url).href;
  const code = `import { withDeviceLock, bindDeviceLockRun } from ${JSON.stringify(module)}; await withDeviceLock('test-device', async () => { await bindDeviceLockRun('test-device', process.argv[1] + '/run', process.argv[1]); console.log('ready'); await new Promise(() => { setInterval(() => {}, 1000); }); }, process.argv[1]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    const alive = await inspectDeviceLock('test-device', root);
    assert.equal(alive.owner, 'alive');
    let called = false;
    await assert.rejects(recoverDeviceLock('test-device', alive.lease.token, async () => { called = true; }, root), /alive/);
    assert.equal(called, false);
    child.kill('SIGKILL');
    await exited;
    const dead = await inspectDeviceLock('test-device', root);
    assert.equal(dead.owner, 'dead');
    assert.equal(dead.lease.runDirectory, await realpath(join(root, 'run')));
    assert.deepEqual(JSON.parse(await readFile(join(root, 'run/device-lease.json'), 'utf8')), dead.lease);
    await assert.rejects(recoverDeviceLock('test-device', 'stale-token', async () => {}, root), /changed/);
    await assert.rejects(recoverDeviceLock('test-device', dead.lease.token, async () => { throw new Error('device offline'); }, root), /device offline/);
    assert.equal((await inspectDeviceLock('test-device', root)).lease.token, dead.lease.token);
    const path = join(root, createHash('sha256').update('test-device').digest('hex') + '.json');
    const predecessor = randomUUID();
    await writeFile(path, JSON.stringify({ ...dead.lease, recoveredFrom: { token: predecessor, runDirectory: dead.lease.runDirectory } }));
    await writeFile(path + '.recovery', JSON.stringify({ pid: child.pid, host: hostname(), expectedToken: randomUUID(), startedAt: new Date().toISOString() }));
    await assert.rejects(recoverDeviceLock('test-device', dead.lease.token, async () => assert.fail('wrong predecessor'), root), /another device lease/);
    await writeFile(path + '.recovery', JSON.stringify({ pid: process.pid, host: hostname(), expectedToken: predecessor, startedAt: new Date().toISOString() }));
    await assert.rejects(recoverDeviceLock('test-device', dead.lease.token, async () => assert.fail('live predecessor guard'), root), /already active/);
    await writeFile(path + '.recovery', JSON.stringify({ pid: child.pid, host: hostname(), expectedToken: predecessor, startedAt: new Date().toISOString() }));
    await recoverDeviceLock('test-device', dead.lease.token, async lease => {
      assert(Object.isFrozen(lease));
      await assert.rejects(withDeviceLock('test-device', async () => {}, root), /Device busy/);
      await assert.rejects(recoverDeviceLock('test-device', dead.lease.token, async () => {}, root), /already active/);
    }, root);
    assert.equal(await inspectDeviceLock('test-device', root), null);
    await writeFile(path + '.recovery', JSON.stringify({ version: 1, pid: child.pid, host: hostname(), expectedToken: dead.lease.token, recoveryToken: '11111111-1111-4111-8111-111111111111', startedAt: new Date().toISOString() }));
    await withDeviceLock('test-device', async () => {}, root);
    await assert.rejects(readFile(path + '.recovery'), /ENOENT/);
    await writeFile(path + '.recovery', JSON.stringify({ version: 1, pid: process.pid, host: hostname(), expectedToken: dead.lease.token, recoveryToken: '11111111-1111-4111-8111-111111111111', startedAt: new Date().toISOString() }));
    await assert.rejects(withDeviceLock('test-device', async () => {}, root), /recovery is active/);
    assert.equal(await inspectDeviceLock('test-device', root), null);
    await rm(path + '.recovery');
    await writeFile(path, JSON.stringify({ ...dead.lease, host: 'another-host' }));
    await assert.rejects(recoverDeviceLock('test-device', dead.lease.token, async () => {}, root), /unknown/);
    await writeFile(path, '{broken');
    await assert.rejects(inspectDeviceLock('test-device', root));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
