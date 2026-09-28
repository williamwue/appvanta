import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { claimTaskContinuation, previewUncertainTaskStep, recordUncertainStepAdjudication,
  readUncertainStepAdjudication, prepareAdjudicatedTaskContinuation,
  readAdjudicatedTaskContinuation, TaskStore } from '../dist/index.js';
import { inspectDeviceAdmissionJournal } from '../dist/device-lock.js';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-uncertain-step-'));
  const store = new TaskStore(join(root, 'tasks'));
  const sourceFlow = { version: 1, name: 'source', steps: [1, 2].map(index => ({ description: `Action ${index}`, action: { kind: 'back' } })) };
  const sourceRun = join(root, 'source-run');
  await mkdir(sourceRun);
  const source = await store.create('device-1', sourceFlow);
  source.status = 'running'; source.runDirectory = sourceRun; await store.save(source);
  await save(join(sourceRun, 'flow.json'), sourceFlow);
  await save(join(sourceRun, 'device.json'), { id: 'device-1' });
  await save(join(sourceRun, 'progress.json'), { version: 1, revision: 1, deviceId: 'device-1', flowSha256: sha(sourceFlow),
    phase: 'boundary', completed: [], active: { flowIndex: 0, step: sourceFlow.steps[0] }, pending: [{ flowIndex: 1, step: sourceFlow.steps[1] }] });
  // TaskStore derives interruption from the dead owner of a persisted running task.
  const deadOwner = async task => save(join(store.directory, task.id, 'task.json'), { ...task, owner: { ...task.owner, pid: 99999999 } });
  await deadOwner(source);
  const { directory, claim } = await claimTaskContinuation(store, source.id, { kind: 'text-visible', text: 'Ready' });
  const successor = await store.create('device-1', claim.flow);
  const successorRun = join(root, 'successor-run');
  await mkdir(successorRun);
  successor.status = 'running'; successor.runDirectory = successorRun; await store.save(successor);
  await deadOwner(successor);
  await save(join(directory, 'successor.json'), { taskId: successor.id });
  await save(join(successorRun, 'continuation.json'), claim);
  await save(join(successorRun, 'flow.json'), claim.flow);
  await save(join(successorRun, 'device.json'), { id: 'device-1' });
  const passed = { index: 1, description: claim.flow.steps[0].description, status: 'passed', evidence: [], durationMs: 1 };
  await writeFile(join(successorRun, 'steps.jsonl'), `${JSON.stringify(passed)}\n`);
  const progress = { version: 1, revision: 3, deviceId: 'device-1', flowSha256: sha(claim.flow), phase: 'executing',
    completed: [{ item: { flowIndex: 0, step: claim.flow.steps[0] }, result: passed, evidenceSha256: {} }],
    active: { flowIndex: 1, step: claim.flow.steps[1] }, pending: [{ flowIndex: 2, step: claim.flow.steps[2] }] };
  await save(join(successorRun, 'progress.json'), progress);
  return { root, store, source, successor, sourceRun, successorRun, directory, claim, progress, passed };
}

async function leaseFixture(f) {
  const directory = join(f.root, 'locks');
  await mkdir(directory);
  const path = join(directory, `${createHash('sha256').update('device-1').digest('hex')}.json`);
  const lease = { version: 1, token: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', deviceId: 'device-1',
    pid: 99999999, host: hostname(), startedAt: new Date().toISOString(), runDirectory: f.successorRun };
  await save(path, lease);
  return { directory, path, lease };
}

async function realVersion2LeaseFixture(f) {
  const directory = join(f.root, 'locks');
  const path = join(directory, `${createHash('sha256').update('device-1').digest('hex')}.json`);
  const module = new URL('../dist/device-lock.js', import.meta.url).href;
  const code = `import { withDeviceLock, bindDeviceLockRun, retainDeviceLockForCleanup } from ${JSON.stringify(module)};
    await withDeviceLock('device-1', async () => {
      await bindDeviceLockRun('device-1', process.argv[2], process.argv[1]);
      await retainDeviceLockForCleanup('device-1', process.argv[2], process.argv[1]);
    }, process.argv[1]);`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory, f.successorRun],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const lease = JSON.parse(await readFile(path, 'utf8'));
  return { directory, path, lease,
    journal: `${path}.admission-${lease.token}.jsonl` };
}

test('adjudication records a bound skip intent without changing task, run, or lease evidence', async () => {
  const f = await fixture();
  try {
    const lock = await leaseFixture(f);
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    assert.match(preview.previewDigestSha256, /^[a-f0-9]{64}$/);
    const tracked = [join(f.store.directory, f.source.id, 'task.json'), join(f.store.directory, f.successor.id, 'task.json'),
      join(f.successorRun, 'progress.json'), join(f.successorRun, 'steps.jsonl'), lock.path];
    const before = await Promise.all(tracked.map(path => readFile(path)));
    const decision = await recordUncertainStepAdjudication(f.store, f.successor.id, {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'operator-1', reason: 'Independent postcondition observed', verdict: 'postcondition-verified-skip',
      postconditionCheckpoint: { kind: 'text-visible', text: 'Done' },
    }, lock.directory);
    assert.equal(decision.resumeAuthorized, false);
    assert.equal(decision.claimId, f.claim.id);
    assert.equal(decision.lease.runDirectory, f.successorRun);
    assert.deepEqual((await readUncertainStepAdjudication(f.store, f.successor.id)).postconditionCheckpoint,
      { kind: 'text-visible', text: 'Done' });
    assert.deepEqual(await Promise.all(tracked.map(path => readFile(path))), before);
    assert.equal((await previewUncertainTaskStep(f.store, f.successor.id)).previewDigestSha256, preview.previewDigestSha256);
    await assert.rejects(recordUncertainStepAdjudication(f.store, f.successor.id, {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'operator-2', reason: 'duplicate', verdict: 'unresolved',
    }, lock.directory), { code: 'EEXIST' });
    assert.equal((await readUncertainStepAdjudication(f.store, f.successor.id)).operator, 'operator-1');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudication validates optional lease metadata before creating a decision', async () => {
  for (const metadata of [
    () => ({ preparationScope: 'other' }),
    () => ({ recoveredFrom: { token: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', unknown: 'value' } }),
    () => ({ processToken: 'invalid' }),
    () => ({ cleanupRequired: null }),
    f => ({ cleanupRequired: { runDirectory: f.sourceRun, recordedAt: new Date().toISOString() } }),
    f => ({ cleanupRequired: { runDirectory: f.successorRun, recordedAt: 'invalid' } }),
    f => ({ cleanupRequired: { runDirectory: f.successorRun, recordedAt: new Date().toISOString(), reason: 'other' } }),
    f => ({ cleanupRequired: { runDirectory: f.successorRun, recordedAt: new Date().toISOString(), unknown: true } }),
    () => ({ unknown: true }),
    () => ({ version: 3 }),
  ]) {
    const f = await fixture();
    try {
      const lock = await leaseFixture(f);
      const preview = await previewUncertainTaskStep(f.store, f.successor.id);
      await save(lock.path, { ...lock.lease, ...metadata(f) });
      await assert.rejects(recordUncertainStepAdjudication(f.store, f.successor.id, {
        expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
        operator: 'operator', reason: 'lease metadata', verdict: 'unresolved',
      }, lock.directory));
      assert.equal((await readdir(join(f.store.directory, f.successor.id))).includes('uncertain-step-adjudication.json'), false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }

  const f = await fixture();
  try {
    const lock = await leaseFixture(f);
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    const metadata = { preparationScope: 'android-flow',
      recoveredFrom: { token: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', runDirectory: f.sourceRun },
      processToken: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      cleanupRequired: { runDirectory: f.successorRun, recordedAt: new Date().toISOString(), reason: 'explicit' } };
    await save(lock.path, { ...lock.lease, ...metadata });
    const decision = await recordUncertainStepAdjudication(f.store, f.successor.id, {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'operator', reason: 'valid recovery metadata', verdict: 'unresolved',
    }, lock.directory);
    assert.deepEqual(decision.lease.snapshot.recoveredFrom, metadata.recoveredFrom);
    assert.deepEqual(decision.lease.snapshot.cleanupRequired, metadata.cleanupRequired);
    assert.equal(decision.lease.snapshot.processToken, metadata.processToken);
    assert.deepEqual(await readUncertainStepAdjudication(f.store, f.successor.id), decision);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('real version 2 dead-owner lease records intent and prepares only a non-runnable continuation', async () => {
  const f = await fixture();
  try {
    const lock = await realVersion2LeaseFixture(f);
    assert.equal(lock.lease.version, 2);
    assert.equal(lock.lease.runDirectory, f.successorRun);
    assert.match(lock.lease.processToken, /^[a-f0-9-]{36}$/);
    assert.equal(lock.lease.cleanupRequired.reason, 'explicit');
    assert.equal(await inspectDeviceAdmissionJournal(lock.lease, lock.directory), 'resolved');
    const init = (await readFile(lock.journal, 'utf8')).trimEnd();
    await writeFile(lock.journal, `${init}\n${JSON.stringify({ version: 1, sequence: 1,
      token: lock.lease.token, deviceId: 'device-1', kind: 'pending',
      id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', operation: 'nested' })}\n`);
    assert.equal(await inspectDeviceAdmissionJournal(lock.lease, lock.directory), 'unresolved');
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    const decision = await recordUncertainStepAdjudication(f.store, f.successor.id, {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'reviewer', reason: 'Observed postcondition; journal remains unresolved',
      verdict: 'postcondition-verified-skip', postconditionCheckpoint: { kind: 'text-visible', text: 'Done' },
    }, lock.directory);
    assert.deepEqual(decision.lease.snapshot, lock.lease);
    assert.equal(decision.resumeAuthorized, false);
    assert.deepEqual(await readUncertainStepAdjudication(f.store, f.successor.id), decision);
    const expected = { decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256,
      leaseToken: lock.lease.token };
    const prepared = await prepareAdjudicatedTaskContinuation(f.store, f.successor.id, expected, lock.directory);
    const readExpected = { ...expected, preparationId: prepared.claim.id,
      preparationDigestSha256: prepared.preparationDigestSha256 };
    assert.equal(prepared.claim.state, 'awaiting-guarded-live-checkpoint');
    assert.equal(prepared.claim.resumeAuthorized, false);
    assert.equal((await readAdjudicatedTaskContinuation(f.store, f.successor.id, readExpected, lock.directory))
      .claim.resumeAuthorized, false);
    await rm(lock.journal);
    await assert.rejects(inspectDeviceAdmissionJournal(lock.lease, lock.directory), { code: 'ENOENT' });
    assert.equal((await readAdjudicatedTaskContinuation(f.store, f.successor.id, readExpected, lock.directory))
      .claim.resumeAuthorized, false);
    await writeFile(lock.journal, 'corrupt\n');
    await assert.rejects(inspectDeviceAdmissionJournal(lock.lease, lock.directory));
    assert.equal((await readAdjudicatedTaskContinuation(f.store, f.successor.id, readExpected, lock.directory))
      .claim.resumeAuthorized, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudication snapshots mutable caller input before the first asynchronous boundary', async () => {
  const f = await fixture();
  try {
    const lock = await leaseFixture(f);
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    const checkpoint = { kind: 'target-visible', target: { kind: 'image-template', path: 'expected.png', scalePercents: [100] } };
    const input = {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'original-operator', reason: 'Original observation', verdict: 'postcondition-verified-skip',
      postconditionCheckpoint: checkpoint,
    };
    const get = f.store.get.bind(f.store);
    let mutated = false;
    f.store.get = async id => {
      if (!mutated) {
        mutated = true;
        input.expectedPreviewDigestSha256 = 'bad';
        input.expectedLeaseToken = 'bad';
        input.operator = '';
        input.reason = '';
        input.verdict = 'unresolved';
        checkpoint.target.path = '';
        checkpoint.target.scalePercents[0] = 0;
      }
      return get(id);
    };
    const decision = await recordUncertainStepAdjudication(f.store, f.successor.id, input, lock.directory);
    assert.equal(mutated, true);
    assert.equal(decision.operator, 'original-operator');
    assert.equal(decision.reason, 'Original observation');
    assert.equal(decision.verdict, 'postcondition-verified-skip');
    assert.deepEqual(decision.postconditionCheckpoint,
      { kind: 'target-visible', target: { kind: 'image-template', path: 'expected.png', scalePercents: [100] } });
    assert.deepEqual(await readUncertainStepAdjudication(f.store, f.successor.id), decision);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudication refuses wrong lease binding, weak checkpoint, and changed preview inputs', async () => {
  const cases = [
    ['progress', f => save(join(f.successorRun, 'progress.json'), { ...f.progress, revision: 4 })],
    ['instruction', async f => { const dir = join(f.store.directory, f.successor.id, 'instructions'); await mkdir(dir); await save(join(dir, 'instruction-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.json'), { version: 1, id: 'instruction-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', taskId: f.successor.id, createdAt: new Date().toISOString(), status: 'queued', step: f.progress.pending[0].step }); }],
    ['cancellation', f => writeFile(join(f.store.directory, f.successor.id, 'cancel.request'), '')],
  ];
  for (const [name, change] of cases) {
    const f = await fixture();
    try {
      const lock = await leaseFixture(f);
      const preview = await previewUncertainTaskStep(f.store, f.successor.id);
      await change(f);
      await assert.rejects(recordUncertainStepAdjudication(f.store, f.successor.id, {
        expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
        operator: 'operator', reason: name, verdict: 'unresolved',
      }, lock.directory));
      assert.equal((await readdir(join(f.store.directory, f.successor.id))).includes('uncertain-step-adjudication.json'), false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  const f = await fixture();
  try {
    const lock = await leaseFixture(f);
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    const input = { expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'operator', reason: 'test', verdict: 'postcondition-verified-skip' };
    await assert.rejects(recordUncertainStepAdjudication(f.store, f.successor.id,
      { ...input, expectedLeaseToken: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', postconditionCheckpoint: { kind: 'text-visible', text: 'Done' } }, lock.directory), /exact dead-owner lease/);
    await save(lock.path, { ...lock.lease, runDirectory: f.sourceRun });
    await assert.rejects(recordUncertainStepAdjudication(f.store, f.successor.id,
      { ...input, postconditionCheckpoint: { kind: 'text-visible', text: 'Done' } }, lock.directory), /exact dead-owner lease/);
    await save(lock.path, lock.lease);
    for (const kind of ['ui-changed', 'screen-stable'])
      await assert.rejects(recordUncertainStepAdjudication(f.store, f.successor.id,
        { ...input, postconditionCheckpoint: kind === 'screen-stable' ? { kind, stableMs: 500 } : { kind } }, lock.directory), /expected application state/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudication read rejects malformed records and cannot return authorization', async () => {
  const f = await fixture();
  try {
    const lock = await leaseFixture(f);
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    await recordUncertainStepAdjudication(f.store, f.successor.id, {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'operator', reason: 'uncertain', verdict: 'unresolved',
    }, lock.directory);
    const path = join(f.store.directory, f.successor.id, 'uncertain-step-adjudication.json');
    const original = JSON.parse(await readFile(path, 'utf8'));
    assert.equal((await readUncertainStepAdjudication(f.store, f.successor.id)).resumeAuthorized, false);
    for (const altered of [{ ...original, resumeAuthorized: true }, { ...original, verdict: 'retry' },
      { ...original, previewDigestSha256: 'bad' }, { ...original, lease: { ...original.lease, token: 'changed' } },
      ...['pid', 'host', 'startedAt'].map(field => {
        const snapshot = { ...original.lease.snapshot };
        delete snapshot[field];
        return { ...original, lease: { ...original.lease, snapshot } };
      }),
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot, pid: 0 } } },
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot, preparationScope: 'other' } } },
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot, version: 3 } } },
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot, processToken: 'bad' } } },
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot, unknown: true } } },
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot,
        cleanupRequired: { runDirectory: f.sourceRun, recordedAt: new Date().toISOString() } } } },
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot,
        cleanupRequired: { runDirectory: f.successorRun, recordedAt: 'bad' } } } },
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot,
        cleanupRequired: { runDirectory: f.successorRun, recordedAt: new Date().toISOString(), unexpected: true } } } },
      { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot,
        recoveredFrom: { token: original.lease.token } } } },
    ]) {
      await save(path, altered);
      await assert.rejects(readUncertainStepAdjudication(f.store, f.successor.id), /Invalid adjudication record/);
    }
    await save(path, { ...original, lease: { ...original.lease, snapshot: { ...original.lease.snapshot,
      recoveredFrom: { token: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', runDirectory: f.sourceRun },
      preparationScope: 'android-flow' } } });
    assert.equal((await readUncertainStepAdjudication(f.store, f.successor.id)).lease.snapshot.recoveredFrom.runDirectory, f.sourceRun);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('post-write race retains the decision but fails closed when lease or progress changes', async () => {
  for (const changed of ['lease', 'progress']) {
    const f = await fixture();
    try {
      const lock = await leaseFixture(f);
      const preview = await previewUncertainTaskStep(f.store, f.successor.id);
      const path = join(f.store.directory, f.successor.id, 'uncertain-step-adjudication.json');
      const get = f.store.get.bind(f.store);
      let modified = false;
      f.store.get = async id => {
        if (!modified && id === f.successor.id) {
          try {
            await readFile(path);
            modified = true;
            if (changed === 'lease') await save(lock.path, { ...lock.lease, token: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' });
            else await save(join(f.successorRun, 'progress.json'), { ...f.progress, revision: 4 });
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return get(id);
      };
      await assert.rejects(recordUncertainStepAdjudication(f.store, f.successor.id, {
        expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
        operator: 'operator', reason: 'race', verdict: 'unresolved',
      }, lock.directory));
      assert.equal(modified, true);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).resumeAuthorized, false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('persisted interrupted successor previews one uncertain step without writing files', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.store.get(f.successor.id)).status, 'interrupted');
    const before = await readdir(join(f.store.directory, f.successor.id));
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    assert.equal(preview.resumeAuthorized, false);
    assert.equal(preview.phase, 'executing');
    assert.equal(preview.sourceTaskId, f.source.id);
    assert.equal(preview.successorTaskId, f.successor.id);
    assert.equal(preview.activeStepIndex, 2);
    assert.deepEqual(preview.activeIdentity, { flowIndex: 1 });
    assert.deepEqual(preview.sourceOrigin, { continuationIndex: 1, flowIndex: 0 });
    assert.deepEqual(preview.activeStep, f.claim.flow.steps[1]);
    for (const name of ['sourceClaim', 'sourceSuccessor', 'successorContinuation', 'successorFlow', 'successorProgress', 'successorSteps'])
      assert.match(preview.evidenceSha256[name].sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readdir(join(f.store.directory, f.successor.id)), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preview rejects source tasks, terminal tasks, broken lineage, and changed evidence', async () => {
  const f = await fixture();
  try {
    await assert.rejects(previewUncertainTaskStep(f.store, f.source.id), /continuation link/);
    const taskPath = join(f.store.directory, f.successor.id, 'task.json');
    const originalTask = await readFile(taskPath);
    for (const status of ['cancelled', 'failed']) {
      await save(taskPath, { ...f.successor, status, finishedAt: new Date().toISOString() });
      await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), new RegExp(status));
    }
    await writeFile(taskPath, originalTask);
    const linkPath = join(f.directory, 'successor.json');
    const originalLink = await readFile(linkPath);
    await rm(linkPath);
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /source successor link/);
    await save(linkPath, { taskId: f.source.id });
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /claim\/link mismatch/);
    await writeFile(linkPath, originalLink);
    const continuationPath = join(f.successorRun, 'continuation.json');
    await save(continuationPath, { ...f.claim, id: 'changed' });
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /claim\/link mismatch/);
    await save(continuationPath, f.claim);
    const changedClaim = { ...f.claim, source: { ...f.claim.source, revision: 999 } };
    await save(join(f.directory, 'claim.json'), changedClaim);
    await save(continuationPath, changedClaim);
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /differs from source boundary/);
    await save(join(f.directory, 'claim.json'), f.claim);
    await save(continuationPath, f.claim);
    const evidencePath = join(f.successorRun, 'ui.xml');
    await writeFile(evidencePath, 'original');
    const evidenceSha256 = { 'ui.xml': { sha256: createHash('sha256').update('original').digest('hex'), bytes: 8 } };
    const completed = { ...f.progress.completed[0], result: { ...f.passed, evidence: ['ui.xml'] }, evidenceSha256 };
    await save(join(f.successorRun, 'progress.json'), { ...f.progress, completed: [completed] });
    await writeFile(join(f.successorRun, 'steps.jsonl'), `${JSON.stringify(completed.result)}\n`);
    await writeFile(evidencePath, 'altered!');
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /hash mismatch/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preview rejects nonexecuting progress and passed or multiple step-log tails', async () => {
  const f = await fixture();
  try {
    const progressPath = join(f.successorRun, 'progress.json');
    const flowPath = join(f.successorRun, 'flow.json');
    await save(flowPath, { ...f.claim.flow, steps: [] });
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /Flow requires non-empty steps/);
    await save(flowPath, f.claim.flow);
    await save(progressPath, { ...f.progress, revision: 0 });
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /Invalid Flow progress snapshot/);
    await save(progressPath, { ...f.progress, phase: 'boundary' });
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /executing phase/);
    await save(progressPath, { ...f.progress, active: undefined });
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /single active step|lost, duplicated or reordered/);
    await save(progressPath, f.progress);
    const stepsPath = join(f.successorRun, 'steps.jsonl');
    const extra = { index: 2, description: f.claim.flow.steps[1].description, status: 'passed', evidence: [] };
    await writeFile(stepsPath, `${JSON.stringify(f.passed)}\n${JSON.stringify(extra)}\n`);
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /step-log-ahead-of-progress/);
    await writeFile(stepsPath, `${JSON.stringify(f.passed)}\n${JSON.stringify(extra)}\n${JSON.stringify({ ...extra, index: 3 })}\n`);
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /step-log-ahead-of-progress/);
    await writeFile(stepsPath, `${JSON.stringify(f.passed)}\n`);
    await save(progressPath, { ...f.progress, pending: [f.progress.active, ...f.progress.pending] });
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /duplicated|reordered/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preview binds both persisted run device identities to tasks and claim', async () => {
  const f = await fixture();
  try {
    for (const run of [f.sourceRun, f.successorRun]) {
      const devicePath = join(run, 'device.json');
      const progressPath = join(run, 'progress.json');
      const originalProgress = JSON.parse(await readFile(progressPath, 'utf8'));
      await save(devicePath, { id: 'other-device' });
      await save(progressPath, { ...originalProgress, deviceId: 'other-device' });
      await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /persisted device identity/);
      await save(devicePath, { id: 'device-1' });
      await save(progressPath, originalProgress);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('preview rejects a progress revision changed between validation and evidence capture', async () => {
  const f = await fixture();
  try {
    const get = f.store.get.bind(f.store);
    let successorReads = 0;
    f.store.get = async id => {
      if (id === f.successor.id && ++successorReads === 2)
        await save(join(f.successorRun, 'progress.json'), { ...f.progress, revision: f.progress.revision + 1 });
      return get(id);
    };
    await assert.rejects(previewUncertainTaskStep(f.store, f.successor.id), /inputs changed during read/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function adjudicatedFixture(verdict = 'postcondition-verified-skip') {
  const f = await fixture();
  const lock = await leaseFixture(f);
  const preview = await previewUncertainTaskStep(f.store, f.successor.id);
  const decision = await recordUncertainStepAdjudication(f.store, f.successor.id, {
    expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
    operator: 'reviewer', reason: 'Independently observed postcondition', verdict,
    ...(verdict === 'postcondition-verified-skip' ? { postconditionCheckpoint: { kind: 'text-visible', text: 'Done' } } : {}),
  }, lock.directory);
  const expected = { decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256,
    leaseToken: lock.lease.token };
  return { ...f, lock, preview, decision, expected };
}

test('adjudicated preparation skips only the uncertain step and remains non-runnable', async () => {
  const f = await adjudicatedFixture();
  try {
    const before = await Promise.all([join(f.successorRun, 'progress.json'),
      join(f.successorRun, 'steps.jsonl'), f.lock.path].map(path => readFile(path)));
    const { directory, claim } = await prepareAdjudicatedTaskContinuation(
      f.store, f.successor.id, f.expected, f.lock.directory);
    assert.equal(directory, join(f.store.directory, f.successor.id, 'adjudicated-continuation'));
    assert.equal(claim.state, 'awaiting-guarded-live-checkpoint');
    assert.equal(claim.resumeAuthorized, false);
    assert.equal(claim.predecessorClaimId, f.claim.id);
    assert.equal(claim.sourceTaskId, f.source.id);
    assert.equal(claim.skipped.stepIndex, 2);
    assert.deepEqual(claim.skipped.sourceOrigin, { continuationIndex: 1, flowIndex: 0 });
    assert.equal(claim.inheritedPassedPrefix.completedSteps, 1);
    assert.equal(claim.inheritedPassedPrefix.originalSourceCompletedSteps, 0);
    assert.deepEqual(claim.inheritedPassedPrefix.evidenceSha256, [{}]);
    assert.deepEqual(claim.flow.steps.map(step => step.description),
      ['Verify adjudicated postcondition on live device', 'Action 2']);
    assert.deepEqual(claim.flow.steps[0].action.condition, f.decision.postconditionCheckpoint);
    assert.deepEqual(claim.stepOrigins, [{ continuationIndex: 1, flowIndex: 2 }]);
    assert.deepEqual(claim.predecessorStepOrigins, [{ continuationIndex: 2, flowIndex: 1 }]);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'preparation.json'), 'utf8')), claim);
    assert.deepEqual(await Promise.all([join(f.successorRun, 'progress.json'),
      join(f.successorRun, 'steps.jsonl'), f.lock.path].map(path => readFile(path))), before);
    const attempts = await Promise.allSettled([1, 2].map(() =>
      prepareAdjudicatedTaskContinuation(f.store, f.successor.id, f.expected, f.lock.directory)));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 0);
    assert(attempts.every(result => result.status === 'rejected'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudicated preparation permits only the exact skip decision, preview, and abandoned lease', async () => {
  const cases = [
    ['wrong decision', async f => ({ ...f.expected, decisionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' })],
    ['wrong preview', async f => ({ ...f.expected, previewDigestSha256: 'b'.repeat(64) })],
    ['wrong lease', async f => ({ ...f.expected, leaseToken: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' })],
    ['missing decision', async f => { await rm(join(f.store.directory, f.successor.id, 'uncertain-step-adjudication.json')); return f.expected; }],
    ['contradictory decision', async f => {
      await save(join(f.store.directory, f.successor.id, 'uncertain-step-adjudication.json'),
        { ...f.decision, verdict: 'unresolved' });
      return f.expected;
    }],
    ['changed progress', async f => { await save(join(f.successorRun, 'progress.json'), { ...f.progress, revision: 4 }); return f.expected; }],
    ['changed lease snapshot', async f => { await save(f.lock.path, { ...f.lock.lease, startedAt: new Date(Date.now() + 1000).toISOString() }); return f.expected; }],
    ['source cancellation', async f => { await writeFile(join(f.store.directory, f.source.id, 'cancel.request'), ''); return f.expected; }],
    ['successor cancellation', async f => { await writeFile(join(f.store.directory, f.successor.id, 'cancel.request'), ''); return f.expected; }],
    ['malformed source claim', async f => {
      const changed = { ...f.claim, id: 'bad' };
      await save(join(f.directory, 'claim.json'), changed);
      await save(join(f.successorRun, 'continuation.json'), changed);
      return f.expected;
    }],
  ];
  for (const [name, change] of cases) {
    const f = await adjudicatedFixture();
    try {
      const expected = await change(f);
      await assert.rejects(prepareAdjudicatedTaskContinuation(f.store, f.successor.id, expected, f.lock.directory), name);
      assert.equal((await readdir(join(f.store.directory, f.successor.id))).includes('adjudicated-continuation'), false, name);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  const f = await adjudicatedFixture('unresolved');
  try {
    await assert.rejects(prepareAdjudicatedTaskContinuation(f.store, f.successor.id, f.expected, f.lock.directory), /decision/);
    assert.equal((await readdir(join(f.store.directory, f.successor.id))).includes('adjudicated-continuation'), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudicated preparation rejects a malformed source claim even when preview and decision agree', async () => {
  const f = await fixture();
  try {
    const lock = await leaseFixture(f);
    const malformed = { ...f.claim, unexpected: true };
    await save(join(f.directory, 'claim.json'), malformed);
    await save(join(f.successorRun, 'continuation.json'), malformed);
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    const decision = await recordUncertainStepAdjudication(f.store, f.successor.id, {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'reviewer', reason: 'observed', verdict: 'postcondition-verified-skip',
      postconditionCheckpoint: { kind: 'text-visible', text: 'Done' },
    }, lock.directory);
    await assert.rejects(prepareAdjudicatedTaskContinuation(f.store, f.successor.id, {
      decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256,
      leaseToken: lock.lease.token,
    }, lock.directory), /Malformed source continuation claim/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudicated preparation orders queued instructions before later pending steps and claims once', async () => {
  const f = await fixture();
  try {
    const lock = await leaseFixture(f);
    const instructionId = 'instruction-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const injected = { description: 'Queued instruction', action: { kind: 'back' } };
    const instructions = join(f.store.directory, f.successor.id, 'instructions');
    await mkdir(instructions);
    await save(join(instructions, `${instructionId}.json`), { version: 1, id: instructionId,
      taskId: f.successor.id, createdAt: new Date().toISOString(), status: 'queued', step: injected });
    const preview = await previewUncertainTaskStep(f.store, f.successor.id);
    const decision = await recordUncertainStepAdjudication(f.store, f.successor.id, {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lock.lease.token,
      operator: 'reviewer', reason: 'observed', verdict: 'postcondition-verified-skip',
      postconditionCheckpoint: { kind: 'text-visible', text: 'Done' },
    }, lock.directory);
    const expected = { decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256,
      leaseToken: lock.lease.token };
    const results = await Promise.allSettled([1, 2].map(() =>
      prepareAdjudicatedTaskContinuation(f.store, f.successor.id, expected, lock.directory)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const claim = results.find(result => result.status === 'fulfilled').value.claim;
    assert.deepEqual(claim.flow.steps.map(step => step.description),
      ['Verify adjudicated postcondition on live device', 'Queued instruction', 'Action 2']);
    assert.deepEqual(claim.stepOrigins, [
      { continuationIndex: 1, instructionId }, { continuationIndex: 2, flowIndex: 2 },
    ]);
    assert.deepEqual(claim.predecessorStepOrigins, [null, { continuationIndex: 2, flowIndex: 1 }]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function treeContents(root) {
  const names = (await readdir(root, { recursive: true })).sort();
  return Promise.all(names.map(async name => {
    const path = join(root, name);
    return [name, (await stat(path)).isFile() ? (await readFile(path)).toString('base64') : null];
  }));
}

test('adjudicated reader rereads the exact non-runnable preparation with zero filesystem side effects', async () => {
  const f = await adjudicatedFixture();
  try {
    const written = await prepareAdjudicatedTaskContinuation(f.store, f.successor.id, f.expected, f.lock.directory);
    const expected = { ...f.expected, preparationId: written.claim.id,
      preparationDigestSha256: written.preparationDigestSha256 };
    assert.equal(written.preparationDigestSha256,
      createHash('sha256').update(await readFile(join(written.directory, 'preparation.json'))).digest('hex'));
    const before = await treeContents(f.root);
    const reread = await readAdjudicatedTaskContinuation(f.store, f.successor.id, expected, f.lock.directory);
    assert.equal(reread.directory, written.directory);
    assert.deepEqual(reread.claim, written.claim);
    assert.equal(reread.claim.resumeAuthorized, false);
    assert.equal(reread.claim.state, 'awaiting-guarded-live-checkpoint');
    assert.deepEqual(await treeContents(f.root), before);
    await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id,
      { ...expected, preparationDigestSha256: 'b'.repeat(64) }, f.lock.directory), /digest/);

    const inFlight = readAdjudicatedTaskContinuation(f.store, f.successor.id, expected, f.lock.directory);
    expected.preparationId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    expected.preparationDigestSha256 = 'b'.repeat(64);
    expected.decisionId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    expected.timeoutMs = 1;
    assert.deepEqual((await inFlight).claim, written.claim);
    assert.deepEqual(await treeContents(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudicated reader does not recreate an absent successor instructions directory', async () => {
  const f = await adjudicatedFixture();
  try {
    const written = await prepareAdjudicatedTaskContinuation(f.store, f.successor.id, f.expected, f.lock.directory);
    const instructionDirectory = join(f.store.directory, f.successor.id, 'instructions');
    await rmdir(instructionDirectory);
    const before = await treeContents(f.root);
    const reread = await readAdjudicatedTaskContinuation(f.store, f.successor.id, {
      ...f.expected, preparationId: written.claim.id,
      preparationDigestSha256: written.preparationDigestSha256,
    }, f.lock.directory);
    assert.deepEqual(reread.claim, written.claim);
    assert.deepEqual(await treeContents(f.root), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudicated reader binds a custom checkpoint timeout and rejects altered or invalid timeouts', async () => {
  const f = await adjudicatedFixture();
  try {
    const written = await prepareAdjudicatedTaskContinuation(f.store, f.successor.id, f.expected, f.lock.directory, 4321);
    const expected = { ...f.expected, preparationId: written.claim.id,
      preparationDigestSha256: written.preparationDigestSha256, timeoutMs: 4321 };
    assert.equal((await readAdjudicatedTaskContinuation(f.store, f.successor.id, expected, f.lock.directory))
      .claim.flow.steps[0].action.timeoutMs, 4321);
    await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id,
      { ...expected, timeoutMs: 4322 }, f.lock.directory), /differs/);
    const path = join(written.directory, 'preparation.json');
    const tampered = structuredClone(written.claim);
    tampered.flow.steps[0].action.timeoutMs = 4322;
    await save(path, tampered);
    await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id, expected, f.lock.directory), /digest/);
    tampered.flow.steps[0].action.timeoutMs = 0;
    await save(path, tampered);
    await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id, expected, f.lock.directory), /timeout|integer/i);
    await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id,
      { ...expected, timeoutMs: 0 }, f.lock.directory), /timeout/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudicated reader rejects malformed, missing, and tampered persisted preparations', async () => {
  const cases = [
    ['preparation ID', claim => { claim.id = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'; }],
    ['state', claim => { claim.state = 'ready'; }],
    ['authorization', claim => { claim.resumeAuthorized = true; }],
    ['Flow', claim => { claim.flow.steps[1].description = 'Changed'; }],
    ['lineage', claim => { claim.predecessorStepOrigins[0].continuationIndex = 99; }],
    ['unknown top-level field', claim => { claim.unexpected = true; }],
    ['unknown nested field', claim => { claim.skipped.unexpected = true; }],
    ['well-formed owner', claim => { claim.owner.host = 'another-host'; }],
    ['well-formed createdAt', claim => { claim.createdAt = new Date(Date.now() + 1000).toISOString(); }],
  ];
  for (const [name, mutate] of cases) {
    const f = await adjudicatedFixture();
    try {
      const { directory, claim, preparationDigestSha256 } = await prepareAdjudicatedTaskContinuation(f.store, f.successor.id, f.expected, f.lock.directory);
      const preparationId = claim.id;
      mutate(claim);
      await save(join(directory, 'preparation.json'), claim);
      await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id,
        { ...f.expected, preparationId, preparationDigestSha256 }, f.lock.directory), name);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
  for (const value of ['not-json', '{}', 'null']) {
    const f = await adjudicatedFixture();
    try {
      const { directory, claim, preparationDigestSha256 } = await prepareAdjudicatedTaskContinuation(f.store, f.successor.id, f.expected, f.lock.directory);
      await writeFile(join(directory, 'preparation.json'), value);
      await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id,
        { ...f.expected, preparationId: claim.id, preparationDigestSha256 }, f.lock.directory), value);
      await rm(join(directory, 'preparation.json'));
      await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id,
        { ...f.expected, preparationId: claim.id, preparationDigestSha256 }, f.lock.directory), { code: 'ENOENT' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('adjudicated reader rejects changed cancellation, decision, lease, and queued instructions', async () => {
  const cases = [
    ['cancellation', async f => writeFile(join(f.store.directory, f.source.id, 'cancel.request'), '')],
    ['decision', async f => save(join(f.store.directory, f.successor.id, 'uncertain-step-adjudication.json'),
      { ...f.decision, verdict: 'unresolved' })],
    ['lease', async f => save(f.lock.path, { ...f.lock.lease, startedAt: new Date(Date.now() + 1000).toISOString() })],
    ['instructions', async f => {
      const directory = join(f.store.directory, f.successor.id, 'instructions');
      await mkdir(directory, { recursive: true });
      const id = 'instruction-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      await save(join(directory, `${id}.json`), { version: 1, id, taskId: f.successor.id,
        createdAt: new Date().toISOString(), status: 'queued', step: { description: 'New action', action: { kind: 'back' } } });
    }],
  ];
  for (const [name, mutate] of cases) {
    const f = await adjudicatedFixture();
    try {
      const { claim, preparationDigestSha256 } = await prepareAdjudicatedTaskContinuation(f.store, f.successor.id, f.expected, f.lock.directory);
      await mutate(f);
      await assert.rejects(readAdjudicatedTaskContinuation(f.store, f.successor.id,
        { ...f.expected, preparationId: claim.id, preparationDigestSha256 }, f.lock.directory), name);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
