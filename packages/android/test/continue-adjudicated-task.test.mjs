import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlow, TaskStore, prepareAdjudicatedTaskContinuation, recordUncertainStepAdjudication,
  previewUncertainTaskStep, reserveAdjudicatedSuccessor } from '@appvanta/core';
import { continueAdjudicatedAndroidTask, validateAdjudicatedAndroidFlow } from '../dist/index.js';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value));

async function executionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-adjudicated-exec-'));
  const store = new TaskStore(join(root, 'tasks'));
  const flow = { version: 1, name: 'source', steps: [
    { description: 'uncertain', action: { kind: 'back' } },
    { description: 'later', action: { kind: 'back' } },
  ] };
  const sourceRun = join(root, 'source-run'); await mkdir(sourceRun);
  const canonicalSourceRun = await realpath(sourceRun);
  const source = await store.create('device-1', flow); source.status = 'running'; source.runDirectory = sourceRun; await store.save(source);
  await save(join(sourceRun, 'flow.json'), flow); await save(join(sourceRun, 'device.json'), { id: 'device-1' });
  await save(join(sourceRun, 'progress.json'), { version: 1, revision: 1, deviceId: 'device-1', flowSha256: sha(flow), phase: 'boundary', completed: [], active: { flowIndex: 0, step: flow.steps[0] }, pending: [{ flowIndex: 1, step: flow.steps[1] }] });
  await save(join(store.directory, source.id, 'task.json'), { ...source, owner: { ...source.owner, pid: 2147483647 } });
  const claimDir = join(store.directory, source.id, 'continuation'); await mkdir(claimDir);
  const claim = { version: 1, id: randomUUID(), sourceTaskId: source.id, deviceId: 'device-1', owner: { pid: 1, host: hostname() }, createdAt: new Date().toISOString(), flow: parseFlow({ version: 1, name: 'Continue: source', steps: [{ description: 'Verify continuation checkpoint', action: { kind: 'wait', condition: { kind: 'text-visible', text: 'Ready' }, timeoutMs: 1000 } }, flow.steps[0], flow.steps[1]] }), source: { runDirectory: canonicalSourceRun, revision: 1, flowSha256: sha(flow), completedSteps: 0 }, omittedResets: [], stepOrigins: [{ continuationIndex: 1, flowIndex: 0 }, { continuationIndex: 2, flowIndex: 1 }], resumeAuthorized: false };
  await save(join(claimDir, 'claim.json'), claim);
  await save(join(sourceRun, 'continuation.json'), claim);
  const successor = await store.create('device-1', claim.flow); const successorRun = join(root, 'successor-run'); await mkdir(successorRun);
  successor.status = 'running'; successor.runDirectory = successorRun; await store.save(successor);
  await save(join(store.directory, successor.id, 'task.json'), { ...successor, owner: { ...successor.owner, pid: 2147483647 } });
  await save(join(claimDir, 'successor.json'), { taskId: successor.id });
  await save(join(successorRun, 'continuation.json'), claim); await save(join(successorRun, 'flow.json'), claim.flow); await save(join(successorRun, 'device.json'), { id: 'device-1' });
  const passed = { index: 1, description: claim.flow.steps[0].description, status: 'passed', evidence: [] };
  await writeFile(join(successorRun, 'steps.jsonl'), `${JSON.stringify(passed)}\n`);
  await save(join(successorRun, 'progress.json'), { version: 1, revision: 2, deviceId: 'device-1', flowSha256: sha(claim.flow), phase: 'executing', completed: [{ item: { flowIndex: 0, step: claim.flow.steps[0] }, result: passed, evidenceSha256: {} }], active: { flowIndex: 1, step: claim.flow.steps[1] }, pending: [{ flowIndex: 2, step: claim.flow.steps[2] }] });
  const locks = join(root, 'locks'); await mkdir(locks); const lockPath = join(locks, `${createHash('sha256').update('device-1').digest('hex')}.json`);
  const oldLease = { version: 1, token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: 'device-1', pid: 2147483647, host: hostname(), startedAt: new Date().toISOString(), runDirectory: successorRun };
  await save(lockPath, oldLease);
  const preview = await previewUncertainTaskStep(store, successor.id);
  const decision = await recordUncertainStepAdjudication(store, successor.id, { expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: oldLease.token, operator: 'test', reason: 'observed', verdict: 'postcondition-verified-skip', postconditionCheckpoint: { kind: 'text-visible', text: 'Done' } }, locks);
  const expected = { decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256, leaseToken: oldLease.token };
  const prepared = await prepareAdjudicatedTaskContinuation(store, successor.id, expected, locks);
  const reservation = await reserveAdjudicatedSuccessor(store, successor.id, { preparationId: prepared.claim.id, preparationDigestSha256: prepared.preparationDigestSha256, ...expected }, locks);
  return { root, store, successor, sourceRun, successorRun, lockPath, oldLease, receipt: { preparationId: prepared.claim.id, preparationDigestSha256: prepared.preparationDigestSha256, ...expected }, reservation };
}

test('adjudicated Android continuation requires a first guarded wait and carries no reset', () => {
  const flow = parseFlow({ name: 'guarded', steps: [
    { description: 'verify', action: { kind: 'wait', condition: { kind: 'text-visible', text: 'ready' }, timeoutMs: 1000 } },
  ] });
  assert.doesNotThrow(() => validateAdjudicatedAndroidFlow(flow));
  assert.throws(() => validateAdjudicatedAndroidFlow({ ...flow, steps: [{ description: 'tap', action: { kind: 'tap', x: 1, y: 1 } }] }), /guarded wait/);
  assert.throws(() => validateAdjudicatedAndroidFlow({ ...flow, resetApplications: ['com.example.app'] }), /no reset/);
});

test('adjudicated continuation fake executes only after exact dead lease transfer and writes lineage', async () => {
  const f = await executionFixture();
  try {
    let runCalled = false;
    const result = await continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
      lockDirectory: f.root + '/locks',
      continueFlow: async (_device, _token, operation, beforeRecovery) => {
        await beforeRecovery?.();
        await save(f.lockPath, { ...f.oldLease, token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', pid: process.pid, recoveredFrom: { token: f.oldLease.token, runDirectory: f.successorRun } });
        return operation(f.successorRun);
      },
      runFlow: async (_device, flow, _signal, onRunCreated) => {
        runCalled = true; assert.equal(flow.steps[0].action.kind, 'wait');
        const run = join(f.root, 'new-run'); await mkdir(run); await onRunCreated?.(run);
        return { status: 'passed', runDirectory: run, report: join(run, 'report.md'), steps: [] };
      },
    });
    assert.equal(runCalled, true);
    assert.equal(result.status, 'passed');
    const marker = JSON.parse(await readFile(join(f.root, 'new-run', 'adjudicated-continuation.json'), 'utf8'));
    assert.equal(marker.predecessorTaskId, f.successor.id);
    assert.equal(marker.resumeAuthorized, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('adjudicated continuation accepts a dead running task while the original lease is unchanged', async () => {
  const f = await executionFixture();
  try {
    const taskPath = join(f.store.directory, f.reservation.reservation.successorTaskId, 'task.json');
    const reservedTask = JSON.parse(await readFile(taskPath, 'utf8'));
    await save(taskPath, { ...reservedTask, status: 'running', owner: { ...reservedTask.owner, pid: 2147483647 } });
    const result = await continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
      lockDirectory: f.root + '/locks',
      continueFlow: async (_device, _token, operation, beforeRecovery) => {
        await beforeRecovery?.();
        await save(f.lockPath, { ...f.oldLease, token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', pid: process.pid, recoveredFrom: { token: f.oldLease.token, runDirectory: f.successorRun } });
        return operation(f.successorRun);
      },
      runFlow: async (_device, _flow, _signal, onRunCreated) => {
        const run = join(f.root, 'recovered-run'); await mkdir(run); await onRunCreated?.(run);
        return { status: 'passed', runDirectory: run, report: join(run, 'report.md'), steps: [] };
      },
    });
    assert.equal(result.status, 'passed');
    assert.equal((await f.store.get(f.reservation.reservation.successorTaskId)).status, 'passed');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a dead transferred lease still rejects the old adjudication receipt before device execution', async () => {
  const f = await executionFixture();
  try {
    const taskPath = join(f.store.directory, f.reservation.reservation.successorTaskId, 'task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8'));
    await save(taskPath, { ...task, status: 'running', owner: { ...task.owner, pid: 2147483647 } });
    await save(f.lockPath, { ...f.oldLease, token: randomUUID(),
      recoveredFrom: { token: f.oldLease.token, runDirectory: f.successorRun } });
    let deviceTouched = false;
    await assert.rejects(continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
      lockDirectory: join(f.root, 'locks'),
      continueFlow: async () => { deviceTouched = true; throw new Error('Unexpected device execution'); },
    }), /exact abandoned successor device lease/);
    assert.equal(deviceTouched, false);
    assert.equal((await f.store.get(task.id)).status, 'interrupted');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
