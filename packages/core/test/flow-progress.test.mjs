import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectFlowProgress, prepareFlowContinuation, inspectTaskProgress, claimTaskContinuation, TaskStore } from '../dist/index.js';
import { fingerprintProgressEvidence } from '../dist/flow-progress.js';

test('evidence permits only appended recovery records and rejects escaping paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-progress-evidence-'));
  try {
    await writeFile(join(root, 'recovery.jsonl'), '{"step":1}\n');
    const expected = await fingerprintProgressEvidence(root, ['recovery.jsonl']);
    await writeFile(join(root, 'recovery.jsonl'), '{"step":2}\n', { flag: 'a' });
    assert.deepEqual(await fingerprintProgressEvidence(root, ['recovery.jsonl'], expected), expected);
    await writeFile(join(root, 'recovery.jsonl'), '{"step":0}\n{"step":2}\n');
    assert.notDeepEqual(await fingerprintProgressEvidence(root, ['recovery.jsonl'], expected), expected);
    await writeFile(join(root, 'recovery.jsonl'), '');
    await assert.rejects(fingerprintProgressEvidence(root, ['recovery.jsonl'], expected));
    for (const path of ['../secret', '/secret', 'C:/secret', 'dir/../secret', 'file:stream']) await assert.rejects(fingerprintProgressEvidence(root, [path]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('killed Flow preserves verified prefix and distinguishes boundary from uncertain action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-progress-'));
  try {
    for (const phase of ['boundary', 'executing']) {
      const source = `
        import { createRunContext, executeFlow } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        let context, count = 0;
        const hold = async () => { process.send({ root: context.rootDirectory }); await new Promise(() => setInterval(() => {}, 1000)); };
        const driver = { name: 'test', observe: async () => { const uiTreePath = join(context.rootDirectory, 'ui.xml'); await writeFile(uiTreePath, '<node/>'); return { capturedAt: new Date().toISOString(), uiTreePath, metadata: {} }; }, execute: async () => { if (++count === 2 && ${JSON.stringify(phase)} === 'executing') await hold(); return { success: true }; }, checkCondition: async () => true };
        const device = { id: 'test', name: 'test', platform: 'android', status: 'online', capabilities: [] };
        context = await createRunContext({ runsDirectory: ${JSON.stringify(root)}, driver, device });
        await executeFlow({ context, driver, resetAppData: async () => {}, flow: { name: 'crash', resetApplications: ['app.test'], steps: [1,2,3].map(i => ({ description: 'Step ' + i, action: { kind: 'back' } })) }, beforeStep: async () => { if (count === 1 && ${JSON.stringify(phase)} === 'boundary') await hold(); } });
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const exited = once(child, 'exit');
      try {
        const [message] = await once(child, 'message', { signal: AbortSignal.timeout(15000) });
        child.kill('SIGKILL'); await exited;
        const progress = JSON.parse(await readFile(join(message.root, 'progress.json'), 'utf8'));
        assert.equal(progress.phase, phase);
        assert.equal(progress.completed.length, 1);
        assert.equal(progress.completed[0].item.flowIndex, 0);
        assert.equal(progress.completed[0].result.status, 'passed');
        assert.equal(progress.active.flowIndex, 1);
        assert.deepEqual(progress.pending.map(item => item.flowIndex), [2]);
        assert.match(progress.flowSha256, /^[a-f0-9]{64}$/);
        const inspection = await inspectFlowProgress(message.root);
        assert.equal(inspection.boundaryConsistent, phase === 'boundary');
        assert.equal(inspection.resumeAuthorized, false);
        assert.equal(inspection.completedSteps, 1);
        assert.equal(inspection.remainingSteps, 2);
        const checkpoint = { kind: 'text-visible', text: 'Ready' };
        if (phase === 'boundary') {
          const prepared = await prepareFlowContinuation(message.root, checkpoint);
          assert.deepEqual(prepared.flow.steps.slice(1).map(step => step.description), ['Step 2', 'Step 3']);
          assert.deepEqual(prepared.stepOrigins, [{ continuationIndex: 1, flowIndex: 1 }, { continuationIndex: 2, flowIndex: 2 }]);
          assert.deepEqual(prepared.flow.steps[0].action, { kind: 'wait', condition: checkpoint, timeoutMs: 10000 });
          assert.equal(prepared.resumeAuthorized, false);
          assert.equal(prepared.flow.resetApplications, undefined);
          assert.deepEqual(prepared.omittedResets, ['app.test']);
          await assert.rejects(prepareFlowContinuation(message.root, { kind: 'ui-changed' }), /expected application state/);
          await assert.rejects(prepareFlowContinuation(message.root, checkpoint, [], 0));
        } else await assert.rejects(prepareFlowContinuation(message.root, checkpoint), /Unsafe continuation boundary/);
        const snapshotPath = join(message.root, 'progress.json');
        const originalSnapshot = await readFile(snapshotPath, 'utf8');
        for (const altered of [
          { ...progress, flowSha256: '0'.repeat(64) },
          { ...progress, pending: [] },
          { ...progress, pending: [progress.active, ...progress.pending] },
          { ...progress, completed: [{ ...progress.completed[0], result: { ...progress.completed[0].result, status: 'failed' } }] },
        ]) {
          await writeFile(snapshotPath, JSON.stringify(altered));
          await assert.rejects(inspectFlowProgress(message.root));
        }
        await writeFile(snapshotPath, originalSnapshot);
        const instruction = { version: 1, id: 'instruction-test', taskId: 'task-test', createdAt: new Date().toISOString(), status: 'claimed', step: { description: 'Injected', action: { kind: 'back' } } };
        const orphan = await inspectFlowProgress(message.root, [instruction]);
        assert(orphan.reasons.includes('instruction-unaccounted:instruction-test'));
        const queued = await inspectFlowProgress(message.root, [{ ...instruction, status: 'queued' }]);
        assert(!queued.reasons.some(reason => reason.startsWith('instruction-')));
        if (phase === 'boundary') {
          const prepared = await prepareFlowContinuation(message.root, checkpoint, [{ ...instruction, status: 'queued' }]);
          assert.deepEqual(prepared.flow.steps.slice(1).map(step => step.description), ['Step 2', 'Injected', 'Step 3']);
          assert.equal(prepared.stepOrigins[1].instructionId, instruction.id);
        }
        await writeFile(snapshotPath, JSON.stringify({ ...progress, pending: [{ instructionId: instruction.id, step: instruction.step }, ...progress.pending] }));
        const reconciled = await inspectFlowProgress(message.root, [instruction]);
        assert.equal(reconciled.boundaryConsistent, phase === 'boundary');
        assert((await inspectFlowProgress(message.root, [])).reasons.includes('instruction-missing:instruction-test'));
        assert((await inspectFlowProgress(message.root, [{ ...instruction, status: 'applied' }])).reasons.includes('instruction-status-conflict:instruction-test'));
        await assert.rejects(inspectFlowProgress(message.root, [{ ...instruction, step: { description: 'Changed', action: { kind: 'back' } } }]), /differs/);
        await writeFile(snapshotPath, originalSnapshot);
        const evidencePath = join(message.root, progress.completed[0].result.evidence[0]);
        const originalEvidence = await readFile(evidencePath);
        await writeFile(evidencePath, 'replaced UI evidence');
        await assert.rejects(inspectFlowProgress(message.root), /hash mismatch/);
        await writeFile(evidencePath, originalEvidence);
        const store = new TaskStore(join(root, 'tasks'));
        const task = await store.create('test', JSON.parse(await readFile(join(message.root, 'flow.json'), 'utf8')));
        task.status = 'running'; task.runDirectory = message.root; await store.save(task);
        assert((await inspectTaskProgress(store, task.id)).reasons.includes('task-running'));
        const taskPath = join(store.directory, task.id, 'task.json');
        await writeFile(taskPath, JSON.stringify({ ...task, owner: { ...task.owner, pid: child.pid } }));
        const interrupted = await inspectTaskProgress(store, task.id);
        assert.equal(interrupted.taskStatus, 'interrupted');
        assert.equal(interrupted.boundaryConsistent, phase === 'boundary');
        if (phase === 'boundary') {
          const claims = await Promise.allSettled([1, 2].map(() => claimTaskContinuation(store, task.id, checkpoint)));
          assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
          assert.equal(claims.filter(item => item.status === 'rejected').length, 1);
          const saved = JSON.parse(await readFile(join(store.directory, task.id, 'continuation', 'claim.json'), 'utf8'));
          assert.equal(saved.sourceTaskId, task.id);
          assert.equal(saved.source.runDirectory, message.root);
          assert.equal(saved.flow.resetApplications, undefined);
          await assert.rejects(claimTaskContinuation(store, task.id, checkpoint), /EEXIST/);
          assert.equal((await store.get(task.id)).status, 'interrupted');
        }
        await writeFile(join(store.directory, task.id, 'cancel.request'), '{}');
        assert((await inspectTaskProgress(store, task.id)).reasons.includes('cancellation-requested'));
        await rm(evidencePath);
        await assert.rejects(inspectFlowProgress(message.root));
        await writeFile(evidencePath, originalEvidence);
      } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      }
    }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
