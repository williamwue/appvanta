import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scenario = process.argv[2];
let delayInspection = false;
let denyMarker = false;
let denyLeaseUnlink = false;
let holdMkdir = false;
let releaseMkdir;
const mkdirGate = new Promise(resolve => { releaseMkdir = resolve; });
let admissionFault;
let appendCount = 0;
let holdAdmission = false;
let admissionEntered;
let releaseAdmission;
const admissionReady = new Promise(resolve => { admissionEntered = resolve; });
const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
let releaseInspection;
let inspectionEntered;
const inspectionGate = new Promise(resolve => { releaseInspection = resolve; });
const entered = new Promise(resolve => { inspectionEntered = resolve; });
mock.module('node:fs/promises', { namedExports: {
  ...fs,
  mkdir: async (...args) => {
    if (holdMkdir) { holdMkdir = false; await mkdirGate; }
    return fs.mkdir(...args);
  },
  unlink: async path => {
    if (denyLeaseUnlink && /^[a-f0-9]{64}\.json$/.test(String(path).split(/[\\/]/).at(-1))) {
      denyLeaseUnlink = false;
      throw Object.assign(new Error('lease unlink EACCES'), { code: 'EACCES' });
    }
    return fs.unlink(path);
  },
  open: async (...args) => {
    if (!String(args[0]).includes('.admission-') || args[1] !== 'a') return fs.open(...args);
    appendCount++;
    if (holdAdmission) {
      holdAdmission = false;
      admissionEntered();
      await admissionGate;
    }
    const handle = await fs.open(...args);
    return {
      writeFile: (...writeArgs) => admissionFault === 'pending' && appendCount === 1 || admissionFault === 'resolved-write' && appendCount === 2
        ? Promise.reject(Object.assign(new Error('admission write EACCES'), { code: 'EACCES' }))
        : handle.writeFile(...writeArgs),
      sync: () => admissionFault === 'resolved' && appendCount === 2
        ? Promise.reject(Object.assign(new Error('resolution fsync EACCES'), { code: 'EACCES' }))
        : handle.sync(),
      close: () => handle.close(),
    };
  },
  readFile: async (...args) => {
    const contents = await fs.readFile(...args);
    if (delayInspection && String(args[0]).endsWith('.json')) {
      delayInspection = false;
      inspectionEntered();
      await inspectionGate;
    }
    return contents;
  },
  writeFile: async (...args) => {
    if (denyMarker && String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('injected marker write failure'), { code: 'EACCES' });
    return fs.writeFile(...args);
  },
} });
const { withDeviceLock, bindDeviceLockRun, retainDeviceLockForCleanup, inspectDeviceLock, recoverDeviceLock } = await import('../../dist/device-lock.js');
const root = await fs.mkdtemp(join(tmpdir(), `appvanta-${scenario}-`));
try {
  if (scenario === 'admitted-nested') {
    let releaseNested, nestedEntered;
    const nestedGate = new Promise(resolve => { releaseNested = resolve; });
    const nestedReady = new Promise(resolve => { nestedEntered = resolve; });
    let nestedResult;
    let parentToken, nestedToken;
    let outerSettled = false;
    const outer = withDeviceLock('device', async () => {
      parentToken = (await inspectDeviceLock('device', root)).lease.token;
      nestedResult = withDeviceLock('device', async () => { nestedToken = (await inspectDeviceLock('device', root)).lease.token; nestedEntered(); await nestedGate; }, root);
      await nestedReady;
    }, root).finally(() => { outerSettled = true; });
    await nestedReady;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outerSettled, false);
    assert.equal((await inspectDeviceLock('device', root)).owner, 'alive');
    releaseNested();
    await nestedResult;
    await outer;
    assert.equal(nestedToken, parentToken);
    assert.equal(await inspectDeviceLock('device', root), null);
  } else if (scenario === 'delayed-inspection') {
    let nestedResult;
    let oldCallbackRan = false;
    await withDeviceLock('device', async () => {
      delayInspection = true;
      nestedResult = withDeviceLock('device', async () => { oldCallbackRan = true; }, root).then(() => 'ran', error => String(error));
      await entered;
    }, root);
    let releaseNewOwner;
    const newOwnerGate = new Promise(resolve => { releaseNewOwner = resolve; });
    let newOwnerEntered;
    const newOwnerReady = new Promise(resolve => { newOwnerEntered = resolve; });
    const newOwner = withDeviceLock('device', async () => { newOwnerEntered(); await newOwnerGate; }, root);
    await newOwnerReady;
    releaseInspection();
    assert.match(await nestedResult, /Device lease changed before nested admission/);
    assert.equal(oldCallbackRan, false);
    assert.equal((await inspectDeviceLock('device', root)).owner, 'alive');
    releaseNewOwner();
    await newOwner;
    assert.equal(await inspectDeviceLock('device', root), null);
  } else if (scenario === 'delayed-inspection-no-replacement') {
    let nestedResult;
    let invoked = false;
    let oldToken;
    await withDeviceLock('device', async () => {
      oldToken = (await inspectDeviceLock('device', root)).lease.token;
      delayInspection = true;
      nestedResult = withDeviceLock('device', async () => { invoked = true; throw new Error('unsafe side effect'); }, root).then(() => 'ran', error => String(error));
      await entered;
    }, root);
    assert.equal(await inspectDeviceLock('device', root), null);
    releaseInspection();
    assert.match(await nestedResult, /Device lease changed before nested admission/);
    assert.equal(invoked, false);
    assert.equal(await inspectDeviceLock('device', root), null);
    await withDeviceLock('device', async () => {
      assert.notEqual((await inspectDeviceLock('device', root)).lease.token, oldToken);
    }, root);
  } else if (scenario === 'closing-admission') {
    let triggerNested;
    const nestedGate = new Promise(resolve => { triggerNested = resolve; });
    let nestedResult;
    let invoked = false;
    let oldToken, nestedToken;
    const outer = withDeviceLock('device', async () => {
      oldToken = (await inspectDeviceLock('device', root)).lease.token;
      nestedResult = nestedGate.then(() => withDeviceLock('device', async () => {
        invoked = true;
        nestedToken = (await inspectDeviceLock('device', root)).lease.token;
        throw new Error('unverified device side effect');
      }, root)).then(() => 'ran', error => String(error));
      delayInspection = true;
    }, root);
    await entered;
    holdMkdir = true;
    triggerNested();
    await new Promise(resolve => setImmediate(resolve));
    releaseInspection();
    await outer;
    releaseMkdir();
    assert.match(await nestedResult, /Device lease is closing; nested admission refused/);
    assert.equal(invoked, false);
    assert.equal(nestedToken, undefined);
    assert.equal(await inspectDeviceLock('device', root), null);
    await withDeviceLock('device', async () => {
      assert.notEqual((await inspectDeviceLock('device', root)).lease.token, oldToken);
    }, root);
  } else if (scenario === 'marker-write-failure') {
    const run = join(root, 'run');
    await fs.mkdir(run);
    await assert.rejects(withDeviceLock('device', async () => {
      await withDeviceLock('device', async () => {
        await bindDeviceLockRun('device', run, root);
        denyMarker = true;
        await assert.rejects(retainDeviceLockForCleanup('device', run, root), { code: 'EACCES' });
      }, root);
    }, root), /remains exclusive/);
    const state = await inspectDeviceLock('device', root);
    assert(state?.lease.runDirectory);
    assert.equal(state.lease.cleanupRequired, undefined);
    await assert.rejects(recoverDeviceLock('device', state.lease.token, async () => { throw new Error('cleanup unverified'); }, root), /cleanup unverified/);
    assert.equal((await inspectDeviceLock('device', root)).lease.token, state.lease.token);
    denyMarker = false;
    await recoverDeviceLock('device', state.lease.token, async () => {}, root);
    assert.equal(await inspectDeviceLock('device', root), null);
  } else if (scenario === 'pending-write-denied' || scenario === 'resolution-write-denied' || scenario === 'resolution-sync-denied') {
    const run = join(root, 'run'); await fs.mkdir(run);
    admissionFault = scenario === 'pending-write-denied' ? 'pending' : scenario === 'resolution-write-denied' ? 'resolved-write' : 'resolved';
    let invoked = false;
    await withDeviceLock('device', async () => {
      await bindDeviceLockRun('device', run, root);
      await assert.rejects(withDeviceLock('device', async () => { invoked = true; }, root), { code: 'EACCES' });
    }, root);
    assert.equal(invoked, scenario !== 'pending-write-denied');
    const state = await inspectDeviceLock('device', root);
    assert(state?.lease.cleanupRequired);
    if (scenario !== 'pending-write-denied') {
      const { inspectDeviceAdmissionJournal } = await import('../../dist/device-lock.js');
      assert.equal(await inspectDeviceAdmissionJournal(state.lease, root), 'unresolved');
    }
  } else if (scenario === 'delayed-admission-finalization') {
    holdAdmission = true;
    let nestedResult;
    let invoked = false;
    const outer = withDeviceLock('device', async () => {
      nestedResult = withDeviceLock('device', async () => { invoked = true; }, root);
      await admissionReady;
    }, root);
    await admissionReady;
    let settled = false;
    void outer.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    releaseAdmission();
    await assert.rejects(nestedResult, /closed during admission/);
    await assert.rejects(outer, /remains exclusive/);
    assert.equal(invoked, false);
    const state = await inspectDeviceLock('device', root);
    assert(state?.lease && !state.lease.runDirectory);
    const { inspectDeviceAdmissionJournal } = await import('../../dist/device-lock.js');
    assert.equal(await inspectDeviceAdmissionJournal(state.lease, root), 'unresolved');
  } else if (scenario === 'recovery-unlink-retry') {
    const run = join(root, 'run'); await fs.mkdir(run);
    await withDeviceLock('device', async () => {
      await bindDeviceLockRun('device', run, root);
      await retainDeviceLockForCleanup('device', run, root);
    }, root);
    const state = await inspectDeviceLock('device', root);
    const { inspectDeviceAdmissionJournal } = await import('../../dist/device-lock.js');
    assert.equal(await inspectDeviceAdmissionJournal(state.lease, root), 'resolved');
    denyLeaseUnlink = true;
    await assert.rejects(recoverDeviceLock('device', state.lease.token, async () => {}, root), { code: 'EACCES' });
    assert.equal((await inspectDeviceLock('device', root)).lease.token, state.lease.token);
    assert.equal(await inspectDeviceAdmissionJournal(state.lease, root), 'resolved');
    await recoverDeviceLock('device', state.lease.token, async () => {}, root);
    assert.equal(await inspectDeviceLock('device', root), null);
  } else if (scenario === 'normal-unlink-retry') {
    denyLeaseUnlink = true;
    await assert.rejects(withDeviceLock('device', async () => {}, root), { code: 'EACCES' });
    const state = await inspectDeviceLock('device', root);
    const { inspectDeviceAdmissionJournal } = await import('../../dist/device-lock.js');
    assert.equal(await inspectDeviceAdmissionJournal(state.lease, root), 'resolved');
    await recoverDeviceLock('device', state.lease.token, async () => {}, root);
    assert.equal(await inspectDeviceLock('device', root), null);
  } else throw new Error(`Unknown scenario: ${scenario}`);
  console.log(`${scenario}: passed`);
} finally {
  releaseInspection();
  releaseMkdir();
  releaseAdmission();
  await fs.rm(root, { recursive: true, force: true });
}
