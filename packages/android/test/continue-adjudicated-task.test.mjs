import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlow, TaskStore, prepareAdjudicatedTaskContinuation, recordUncertainStepAdjudication,
  previewUncertainTaskStep, reserveAdjudicatedSuccessor, readAdjudicatedExecution } from '@appvanta/core';
import { continueAdjudicatedAndroidTask, validateAdjudicatedAndroidFlow } from '../dist/index.js';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value));

async function executionFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'appvanta-adjudicated-exec-')));
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
        await save(join(run, 'flow.json'), flow);
        return { status: 'passed', runDirectory: run, report: join(run, 'report.md'), steps: [] };
      },
    });
    assert.equal(runCalled, true);
    assert.equal(result.status, 'passed');
    const marker = JSON.parse(await readFile(join(f.root, 'new-run', 'adjudicated-continuation.json'), 'utf8'));
    assert.equal(marker.predecessorTaskId, f.successor.id);
    assert.equal(marker.resumeAuthorized, false);
    assert.deepEqual(marker.preparationReceipt, f.receipt);
    const verified = await readAdjudicatedExecution(f.store, f.successor.id, result.taskId, f.receipt);
    assert.equal(verified.resumeAuthorized, false);
    assert.equal(verified.runDirectory, await realpath(join(f.root, 'new-run')));
    await assert.rejects(readAdjudicatedExecution(f.store, f.successor.id, result.taskId,
      { ...f.receipt, preparationDigestSha256: '0'.repeat(64) }), /receipt|digest/i);
    const markerPath = join(f.root, 'new-run', 'adjudicated-continuation.json');
    for (const changed of [{ ...marker, successorTaskId: f.successor.id },
      { ...marker, reservationDigestSha256: '0'.repeat(64) }, { ...marker, resumeAuthorized: true }]) {
      await save(markerPath, changed);
      await assert.rejects(readAdjudicatedExecution(f.store, f.successor.id, result.taskId, f.receipt), /lineage mismatch/);
    }
    await save(markerPath, marker);
    await save(join(f.root, 'new-run', 'flow.json'), { ...f.reservation.task.flow, name: 'changed' });
    await assert.rejects(readAdjudicatedExecution(f.store, f.successor.id, result.taskId, f.receipt), /Flow mismatch/);
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

test('cancelled reserved successor is rejected before entering Android recovery', async () => {
  const f = await executionFixture();
  try {
    await f.store.requestCancel(f.reservation.task.id);
    const leaseBefore = await readFile(f.lockPath, 'utf8');
    let touched = false;
    await assert.rejects(continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
      lockDirectory: join(f.root, 'locks'),
      continueFlow: async () => { touched = true; throw new Error('Unexpected recovery'); },
    }), /cancellation requested/);
    assert.equal(touched, false);
    assert.equal(await readFile(f.lockPath, 'utf8'), leaseBefore);
    assert.equal((await f.store.get(f.reservation.task.id)).status, 'cancelling');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function unstartedTransfer(f) {
  await save(join(f.successorRun, 'device-lease.json'), f.oldLease);
  const lease = { ...f.oldLease, version: 2, token: randomUUID(), preparationScope: 'android-flow',
    recoveredFrom: { token: f.oldLease.token, runDirectory: f.successorRun } };
  await save(f.lockPath, lease);
  const journal = `${f.lockPath}.admission-${lease.token}.jsonl`;
  const init = { version: 1, sequence: 0, token: lease.token, deviceId: lease.deviceId, kind: 'init' };
  await writeFile(journal, JSON.stringify(init) + '\n');
  const taskPath = join(f.store.directory, f.reservation.task.id, 'task.json');
  const task = JSON.parse(await readFile(taskPath, 'utf8'));
  await save(taskPath, { ...task, status: 'running', owner: { ...task.owner, pid: 2147483647 } });
  return { lease, journal, init };
}

for (const depth of [1, 3]) test(`explicit unstarted transfer retry at depth ${depth} keeps the task and original receipt`, async () => {
  const f = await executionFixture();
  try {
    let { lease } = await unstartedTransfer(f);
    for (let index = 1; index < depth; index++) {
      const previous = lease;
      lease = { ...lease, token: randomUUID(), recoveredFrom: { token: previous.token, runDirectory: f.successorRun } };
      await save(`${f.lockPath}.predecessor-${lease.token}.json`, previous);
      await save(f.lockPath, lease);
      await writeFile(`${f.lockPath}.admission-${lease.token}.jsonl`, JSON.stringify({ version: 1, sequence: 0, token: lease.token, deviceId: lease.deviceId, kind: 'init' }) + '\n');
    }
    const result = await continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
      lockDirectory: join(f.root, 'locks'), transferRetryToken: lease.token,
      continueFlow: async (_device, token, operation, beforeRecovery) => {
        assert.equal(token, lease.token);
        await beforeRecovery();
        await save(f.lockPath, { ...lease, token: randomUUID(), pid: process.pid,
          recoveredFrom: { token: lease.token, runDirectory: f.successorRun } });
        return operation(f.successorRun);
      },
      runFlow: async (_device, flow, _signal, created) => {
        const run = join(f.root, 'retry-run'); await mkdir(run); await created(run);
        await save(join(run, 'flow.json'), flow);
        return { status: 'passed', runDirectory: run, report: join(run, 'report.md'), steps: [] };
      },
    });
    assert.equal(result.taskId, f.reservation.task.id);
    assert.equal(result.status, 'passed');
    const verified = await readAdjudicatedExecution(f.store, f.successor.id, result.taskId, f.receipt);
    assert.equal(verified.resumeAuthorized, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const fault of ['live-owner', 'wrong-token', 'cleanup', 'binding', 'source-copy', 'pending', 'resolved-work']) {
  test(`unstarted transfer retry rejects ${fault} before device recovery`, async () => {
    const f = await executionFixture();
    try {
      const { lease, journal, init } = await unstartedTransfer(f);
      if (fault === 'live-owner') await save(f.lockPath, { ...lease, pid: process.pid });
      if (fault === 'cleanup') await save(f.lockPath, { ...lease, cleanupRequired: {
        runDirectory: lease.runDirectory, recordedAt: new Date().toISOString(), reason: 'explicit' } });
      if (fault === 'binding') await writeFile(`${f.lockPath}.binding-${lease.token}.json`, '');
      if (fault === 'source-copy') await save(join(f.successorRun, 'device-lease.json'), { ...f.oldLease, token: randomUUID() });
      if (fault === 'pending' || fault === 'resolved-work') {
        const pending = { ...init, sequence: 1, kind: 'pending', id: randomUUID(), operation: 'android-flow' };
        const records = [init, pending];
        if (fault === 'resolved-work') records.push({ ...pending, sequence: 2, kind: 'resolved' });
        await writeFile(journal, records.map(JSON.stringify).join('\n') + '\n');
      }
      const before = await readFile(f.lockPath, 'utf8');
      let touched = false;
      await assert.rejects(continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
        lockDirectory: join(f.root, 'locks'), transferRetryToken: fault === 'wrong-token' ? randomUUID() : lease.token,
        continueFlow: async () => { touched = true; throw new Error('Unexpected device recovery'); },
      }), fault === 'binding' ? /binding intent/ : fault === 'source-copy' ? /source lease evidence/
        : fault === 'pending' || fault === 'resolved-work' ? /admitted work/ : /not an unstarted/);
      assert.equal(touched, false);
      assert.equal(await readFile(f.lockPath, 'utf8'), before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const fault of ['missing-predecessor', 'wrong-predecessor', 'ancestor-binding', 'ancestor-work', 'cycle']) {
  test(`transfer chain rejects ${fault} before recovery`, async () => {
    const f = await executionFixture();
    try {
      const { lease, journal, init } = await unstartedTransfer(f);
      const current = { ...lease, token: randomUUID(), recoveredFrom: { token: lease.token, runDirectory: f.successorRun } };
      await save(f.lockPath, current);
      await writeFile(`${f.lockPath}.admission-${current.token}.jsonl`, JSON.stringify({ ...init, token: current.token }) + '\n');
      if (fault !== 'missing-predecessor') await save(`${f.lockPath}.predecessor-${current.token}.json`, {
        ...lease, ...(fault === 'wrong-predecessor' ? { token: randomUUID() } : {}),
        ...(fault === 'cycle' ? { recoveredFrom: { token: current.token, runDirectory: f.successorRun } } : {}),
      });
      if (fault === 'cycle') await save(`${f.lockPath}.predecessor-${lease.token}.json`, current);
      if (fault === 'ancestor-binding') await writeFile(`${f.lockPath}.binding-${lease.token}.json`, '');
      if (fault === 'ancestor-work') await writeFile(journal, JSON.stringify(init) + '\n' + JSON.stringify({ ...init, sequence: 1, kind: 'pending', id: randomUUID(), operation: 'android-flow' }) + '\n');
      let touched = false;
      await assert.rejects(continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
        lockDirectory: join(f.root, 'locks'), transferRetryToken: current.token,
        continueFlow: async () => { touched = true; throw new Error('Unexpected recovery'); },
      }), fault === 'missing-predecessor' ? /ENOENT/ : fault === 'wrong-predecessor' ? /predecessor mismatch/
        : fault === 'ancestor-binding' ? /binding intent/ : fault === 'ancestor-work' ? /admitted work/ : /not an unstarted/);
      assert.equal(touched, false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const mode of ['poll', 'step', 'caller', 'read-error']) {
  test(`adjudicated execution stops on ${mode} and persists its outcome`, async () => {
    const f = await executionFixture();
    const caller = new AbortController();
    try {
      await assert.rejects(continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
        lockDirectory: join(f.root, 'locks'), signal: caller.signal,
        continueFlow: async (_device, _token, operation, beforeRecovery) => {
          await beforeRecovery?.();
          await save(f.lockPath, { ...f.oldLease, token: randomUUID(), pid: process.pid,
            recoveredFrom: { token: f.oldLease.token, runDirectory: f.successorRun } });
          return operation(f.successorRun);
        },
        runFlow: async (_device, _flow, signal, onRunCreated, controls) => {
          const run = join(f.root, 'cancelled-run'); await mkdir(run); await onRunCreated(run);
          if (mode === 'caller') caller.abort(new Error('caller cancelled'));
          else if (mode === 'read-error') f.store.cancellationRequested = async () => { throw new Error('cancel read failed'); };
          else await new TaskStore(f.store.directory).requestCancel(f.reservation.task.id);
          if (mode === 'step') await controls.beforeStep();
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { signal.removeEventListener('abort', aborted); reject(new Error('abort timeout')); }, 3000);
            const aborted = () => { clearTimeout(timeout); reject(signal.reason); };
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) { signal.removeEventListener('abort', aborted); aborted(); }
          });
          throw new Error('execution continued after cancellation');
        },
      }), mode === 'read-error' ? /cancel read failed/ : /cancell/);
      const task = JSON.parse(await readFile(join(f.store.directory, f.reservation.task.id, 'task.json'), 'utf8'));
      assert.equal(task.status, mode === 'read-error' ? 'failed' : 'cancelled');
      assert.ok(task.finishedAt);
      assert.equal(task.runDirectory, join(f.root, 'cancelled-run'));
      const lease = JSON.parse(await readFile(f.lockPath, 'utf8'));
      assert.equal(lease.recoveredFrom.token, f.oldLease.token);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test('a simulated second executing crash can be previewed and adjudicated with its new lease', async () => {
  const f = await executionFixture();
  try {
    let runRoot;
    await assert.rejects(continueAdjudicatedAndroidTask(f.store, f.successor.id, f.receipt, {
      lockDirectory: join(f.root, 'locks'),
      continueFlow: async (_device, _token, operation, beforeRecovery) => {
        await beforeRecovery();
        await save(f.lockPath, { ...f.oldLease, token: randomUUID(), pid: process.pid,
          recoveredFrom: { token: f.oldLease.token, runDirectory: f.successorRun } });
        return operation(f.successorRun);
      },
      runFlow: async (_device, flow, _signal, created) => {
        runRoot = join(f.root, 'second-crash'); await mkdir(runRoot); await created(runRoot);
        await save(join(runRoot, 'flow.json'), flow);
        await save(join(runRoot, 'device.json'), { id: 'device-1' });
        await save(join(runRoot, 'progress.json'), { version: 1, revision: 1, deviceId: 'device-1',
          flowSha256: sha(flow), phase: 'executing', completed: [], active: { flowIndex: 0, step: flow.steps[0] },
          pending: flow.steps.slice(1).map((step, index) => ({ flowIndex: index + 1, step })) });
        throw new Error('simulated process crash');
      },
    }), /simulated process crash/);
    const id = f.reservation.task.id;
    const taskPath = join(f.store.directory, id, 'task.json');
    const raw = JSON.parse(await readFile(taskPath, 'utf8'));
    delete raw.finishedAt; delete raw.error;
    await save(taskPath, { ...raw, status: 'running', owner: { ...raw.owner, pid: 2147483647 } });
    const lease = JSON.parse(await readFile(f.lockPath, 'utf8'));
    await save(f.lockPath, { ...lease, pid: 2147483647, runDirectory: await realpath(runRoot) });
    const preview = await previewUncertainTaskStep(f.store, id);
    assert.equal(preview.sourceTaskId, f.successor.id);
    assert.equal(preview.resumeAuthorized, false);
    const decision = await recordUncertainStepAdjudication(f.store, id, {
      expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lease.token,
      operator: 'test', reason: 'fresh observation after second crash', verdict: 'postcondition-verified-skip',
      postconditionCheckpoint: { kind: 'text-visible', text: 'Done again' },
    }, join(f.root, 'locks'));
    const expected = { decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256, leaseToken: lease.token };
    const prepared = await prepareAdjudicatedTaskContinuation(f.store, id, expected, join(f.root, 'locks'));
    const secondReceipt = { ...expected, preparationId: prepared.claim.id, preparationDigestSha256: prepared.preparationDigestSha256 };
    const reserved = await reserveAdjudicatedSuccessor(f.store, id, secondReceipt, join(f.root, 'locks'));
    assert.notEqual(reserved.task.id, id);
    assert.equal(reserved.task.flow.steps[0].action.condition.text, 'Done again');
    assert.equal(reserved.task.flow.steps.length, 2);
    assert.equal(prepared.claim.resumeAuthorized, false);
    const second = await continueAdjudicatedAndroidTask(f.store, id, secondReceipt, {
      lockDirectory: join(f.root, 'locks'),
      continueFlow: async (_device, token, operation, beforeRecovery) => {
        await beforeRecovery();
        await save(f.lockPath, { ...lease, token: randomUUID(), pid: process.pid, runDirectory: await realpath(runRoot),
          recoveredFrom: { token, runDirectory: await realpath(runRoot) } });
        return operation(await realpath(runRoot));
      },
      runFlow: async (_device, flow, _signal, created) => {
        const nextRun = join(f.root, 'second-adjudication'); await mkdir(nextRun); await created(nextRun);
        await save(join(nextRun, 'flow.json'), flow);
        return { status: 'passed', runDirectory: nextRun, report: join(nextRun, 'report.md'), steps: [] };
      },
    });
    assert.equal(second.status, 'passed');
    assert.equal((await readAdjudicatedExecution(f.store, id, second.taskId, secondReceipt)).resumeAuthorized, false);
    await save(join(runRoot, 'continuation.json'), {});
    await assert.rejects(previewUncertainTaskStep(f.store, id), /ambiguous/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
