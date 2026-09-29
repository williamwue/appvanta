import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { TaskStore, inspectDeviceLock, withDeviceLock, readAdjudicatedExecution } from '../packages/core/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const deviceId = process.argv[2];
if (!deviceId) throw new Error('Usage: node scripts/verify-task-continuation.mjs <device-id>');
const root = resolve(import.meta.dirname, '..');
const directory = join(root, '.appvanta/runs', `task-continuation-${Date.now()}`);
await mkdir(directory, { recursive: true });
const store = new TaskStore(join(root, '.appvanta/tasks'));
const records = [];
const transport = process.argv[3] ?? 'cli';
const cancel = process.argv[4] === 'cancel';
const crash = process.argv[4] === 'crash';
const adjudicateViaMcp = process.argv[5] === 'mcp-adjudicate';
const adjudicate = process.argv[5] === 'adjudicate' || adjudicateViaMcp;
const fileConflict = process.argv[6] === 'file-conflict';
const fileFixture = process.argv[6] === 'file-fixture' || fileConflict;
const restartViaMcp = process.argv[7] === 'restart-boundary-mcp';
const restartBoundary = process.argv[7] === 'restart-boundary' || restartViaMcp;
const repeatAdjudication = process.argv[7] === 'repeat-adjudication';
const transferBeforeBind = process.argv[7] === 'transfer-before-bind';
if (process.argv[7] && !restartBoundary && !repeatAdjudication && !transferBeforeBind) throw new Error('Unknown restart scenario');
if ((restartBoundary || repeatAdjudication || transferBeforeBind) && !adjudicate) throw new Error('Restart requires adjudication');
if (process.argv[6] && !fileFixture) throw new Error('Unknown fixture scenario');
if (fileFixture && !adjudicate) throw new Error('File fixture scenario requires adjudication');
const fixturePath = `/storage/emulated/0/Download/appvanta-continuation-${randomUUID()}.txt`;
const originalContent = 'Original file: 中文\nPreserve this content.';
const preparedContent = 'Temporary continuation fixture';
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', deviceId, ...args], { windowsHide: true, timeout: 15000, encoding: 'utf8' })).stdout;
if (adjudicate && !crash) throw new Error('Adjudication scenario requires a crashed worker');
if ((cancel || crash) && transport !== 'worker') throw new Error('Interruption scenario requires worker transport');
if (!['cli', 'mcp', 'worker'].includes(transport)) throw new Error('Transport must be cli, mcp or worker');
async function mcpContinue(args) {
  const checkpoint = JSON.parse(await readFile(args[3], 'utf8'));
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  let result;
  lines.on('line', line => {
    const response = JSON.parse(line);
    if (response.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: transport === 'worker' ? 'start_task_continuation' : 'continue_task', arguments: { taskId: args[1], leaseToken: args[2], checkpoint } } }) + '\n');
    }
    if (response.id === 2) { result = response; child.stdin.end(); }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'continuation-verifier', version: '1' } } }) + '\n');
  try {
    await exited; assert(result, `MCP exited without continuation result: ${stderr}`);
    if (transport === 'worker' && !result.error && !result.result?.isError) {
      const started = JSON.parse(result.result.content[0].text);
      assert.notEqual(started.workerPid, child.pid);
      const readyTask = await store.get(started.taskId);
      assert(readyTask.runDirectory, 'Ready successor must already have a bound run');
      const readyLease = JSON.parse(await readFile(join(readyTask.runDirectory, 'device-lease.json'), 'utf8'));
      assert.equal(readyLease.pid, started.workerPid);
      assert.equal(readyLease.deviceId, deviceId);
      await readFile(join(readyTask.runDirectory, 'flow.json'), 'utf8');
      await readFile(join(readyTask.runDirectory, 'progress.json'), 'utf8');
      const deadline = Date.now() + 90000;
      let cancellation;
      while (Date.now() < deadline) {
        const task = await store.get(started.taskId);
        if ((cancel || crash) && !cancellation && task.runDirectory) {
          let progress;
          try { progress = JSON.parse(await readFile(join(task.runDirectory, 'progress.json'), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (progress?.phase === 'executing') {
            if (crash) {
              const owned = await inspectDeviceLock(deviceId);
              assert.equal(owned.lease.pid, started.workerPid);
              assert.equal(task.owner.pid, started.workerPid);
              process.kill(started.workerPid, 'SIGKILL');
            } else {
              const response = await cli(['cancel-task', task.id]); assert.equal(response.code, 0, response.stderr);
            }
            cancellation = { requestedAt: new Date().toISOString(), afterMcpExit: true, phase: progress.phase, method: crash ? 'SIGKILL' : 'cancel-task' };
          }
        }
        const lease = await inspectDeviceLock(deviceId);
        if (['passed', 'failed', 'cancelled', ...(crash ? ['interrupted'] : [])].includes(task.status) && (!lease || lease.owner === 'dead')) {
          if (cancel || crash) assert(cancellation, 'Interruption must occur while the checkpoint is executing');
          return { code: task.status === 'passed' ? 0 : 1, stdout: JSON.stringify(result), stderr, mcpPid: child.pid, workerPid: started.workerPid, cancellation };
        }
        await new Promise(done => setTimeout(done, 100));
      }
      throw new Error('Continuation worker did not finish after MCP exit');
    }
    return { code: result.error || result.result?.isError ? 1 : 0, stdout: JSON.stringify(result), stderr };
  } finally { clearTimeout(timer); lines.close(); }
}
async function cli(args) {
  if (transport !== 'cli' && args[0] === 'continue-task') return mcpContinue(args);
  const child = spawn(process.execPath, ['packages/cli/dist/index.js', ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  try { const [code] = await once(child, 'exit'); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}
async function mcpAdjudication(args) {
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  try {
    const initialized = readMcpResponses(child.stdout, [1], 10000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adjudication-verifier', version: '1' } } }) + '\n');
    await initialized;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const name = args[0].replaceAll('-', '_');
    const field = name === 'adjudicate_task' ? 'decision' : name === 'prepare_adjudicated_task' ? 'expectation' : 'receipt';
    const input = name === 'restart_adjudicated_task'
      ? { predecessorTaskId: args[1], successorTaskId: args[2], receipt: JSON.parse(await readFile(args[3], 'utf8')), leaseToken: args[4], checkpoint: JSON.parse(await readFile(args[5], 'utf8')) }
      : { taskId: args[1], ...(args[2] ? { [field]: JSON.parse(await readFile(args[2], 'utf8')) } : {}) };
    if (name === 'continue_adjudicated_task' && args[3]) input.transferRetryToken = args[3];
    const response = readMcpResponses(child.stdout, [2], 120000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: input } }) + '\n');
    const messages = await response;
    const result = messages.find(message => message.id === 2);
    assert(result?.result && !result.result.isError, JSON.stringify({ result, stderr }));
    return JSON.parse(result.result.content[0].text);
  } finally { child.kill(); await exited; }
}
try {
if (fileFixture) await withDeviceLock(deviceId, async () => {
  const original = join(directory, 'fixture-original.txt');
  await writeFile(original, originalContent);
  await adb('shell', 'test', '!', '-e', fixturePath);
  await adb('push', original, fixturePath);
  assert.equal(await adb('exec-out', 'cat', fixturePath), originalContent);
});
for (const mismatch of cancel || crash ? [true] : [false, true]) {
  const source = `
    import { TaskStore, parseFlow } from ${JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href)};
    import { runAndroidFlow } from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};
    const store = new TaskStore(${JSON.stringify(store.directory)});
    const flow = parseFlow({ name: 'Continuation device check', ...${JSON.stringify(fileFixture ? { files: [{ path: fixturePath, content: preparedContent }] } : {})}, steps: [
      { description: 'Completed Home action', action: { kind: 'button', button: 'home' } },
      { description: 'Remaining Back action', action: { kind: 'back' } },
      ...${JSON.stringify(repeatAdjudication ? [{ description: 'Repeated uncertain wait', action: { kind: 'wait', condition: { kind: 'text-visible', text: 'appvanta-intentionally-absent-second-wait' }, timeoutMs: 90000 } }] : [])},
      { description: 'Final evidence', echo: 'continued' }
    ] });
    const task = await store.create(${JSON.stringify(deviceId)}, flow);
    task.status = 'running'; await store.save(task);
    let boundary = 0;
    await runAndroidFlow(task.deviceId, flow, undefined, async root => { task.runDirectory = root; await store.save(task); }, {
      drain: async () => [], finish: async () => {}, beforeStep: async () => {
        if (++boundary === 2) { process.send({ taskId: task.id, root: task.runDirectory }); await new Promise(() => setInterval(() => {}, 1000)); }
      }
    });
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; owner.stderr.on('data', data => { stderr += data; });
  const exited = once(owner, 'exit');
  try {
    const [message] = await Promise.race([
      once(owner, 'message', { signal: AbortSignal.timeout(90000) }),
      exited.then(() => { throw new Error(`Owner exited before boundary: ${stderr}`); }),
    ]);
    owner.kill('SIGKILL'); await exited;
    assert.equal((await store.get(message.taskId)).status, 'interrupted');
    const lease = await inspectDeviceLock(deviceId); assert.equal(lease.owner, 'dead');
    const checkpoint = mismatch ? { kind: 'text-visible', text: `missing-${Date.now()}` } : { kind: 'app-running', packageName: 'com.android.systemui' };
    const path = join(directory, mismatch ? 'mismatch.json' : 'checkpoint.json'); await writeFile(path, JSON.stringify(checkpoint));
    const result = await cli(['continue-task', message.taskId, lease.lease.token, path]);
    const successor = JSON.parse(await readFile(join(store.directory, message.taskId, 'continuation/successor.json'), 'utf8'));
    const task = await store.get(successor.taskId);
    if (fileFixture) assert.equal(await adb('exec-out', 'cat', fixturePath), preparedContent, 'Interrupted successor must have applied its fixture');
    assert.equal(task.status, crash ? 'interrupted' : cancel ? 'cancelled' : mismatch ? 'failed' : 'passed', JSON.stringify({ task, result }));
    let notification;
    const notificationPath = join(store.directory, task.id, 'notifications/completion.json');
    if (crash) {
      await assert.rejects(readFile(notificationPath), { code: 'ENOENT' });
      const inspection = await cli(['inspect-task-progress', task.id]);
      assert.equal(inspection.code, 1);
      assert(JSON.parse(inspection.stdout).reasons.includes('phase-executing'));
      const retained = await inspectDeviceLock(deviceId);
      const retry = await cli(['continue-task', task.id, retained.lease.token, path]);
      assert.equal(retry.code, 1);
    } else {
      notification = JSON.parse(await readFile(notificationPath, 'utf8'));
      assert.equal(notification.event.status, task.status);
      assert.equal(notification.event.taskId, task.id);
      assert.equal(notification.delivery, 'local');
    }
    assert.equal(result.code, mismatch ? 1 : 0);
    let stepLog = '';
    try { stepLog = await readFile(join(task.runDirectory, 'steps.jsonl'), 'utf8'); }
    catch (error) { if (!crash || error.code !== 'ENOENT') throw error; }
    const steps = stepLog.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert(!steps.some(step => step.description === 'Completed Home action'));
    assert.equal(steps.length, crash ? 0 : mismatch ? 1 : 3);
    if (!crash) assert.equal(steps[0].description, 'Verify continuation checkpoint');
    const link = JSON.parse(await readFile(join(task.runDirectory, 'continuation.json'), 'utf8'));
    assert.equal(link.sourceTaskId, message.taskId);
    assert.equal((await store.get(message.taskId)).status, 'interrupted');
    const duplicate = await cli(['continue-task', message.taskId, lease.lease.token, path]); assert.equal(duplicate.code, 1);
    let adjudication;
    if (adjudicate) {
      const invoke = async args => {
        if (adjudicateViaMcp) return mcpAdjudication(args);
        const response = await cli(args);
        assert.equal(response.code, 0, JSON.stringify(response));
        return JSON.parse(response.stdout);
      };
      const preview = await invoke(['preview-uncertain-task', task.id]);
      const retained = await inspectDeviceLock(deviceId);
      // The crashed step is a read-only wait. Observe System UI now before
      // recording a replacement postcondition; do not claim the missing text appeared.
      const observed = await promisify(execFile)('adb', ['-s', deviceId, 'shell', 'pidof', 'com.android.systemui'], { windowsHide: true, timeout: 10000 });
      assert.match(observed.stdout.trim(), /^\d+( \d+)*$/);
      await writeFile(join(directory, 'postcondition-observation.json'), JSON.stringify({ deviceId,
        observedAt: new Date().toISOString(), packageName: 'com.android.systemui', pids: observed.stdout.trim() }));
      const decisionPath = join(directory, 'decision.json');
      await writeFile(decisionPath, JSON.stringify({ expectedPreviewDigestSha256: preview.previewDigestSha256,
        expectedLeaseToken: retained.lease.token, operator: 'emulator-verifier',
        reason: 'Interrupted read-only checkpoint is replaced with an explicit System UI checkpoint',
        verdict: 'postcondition-verified-skip', postconditionCheckpoint: { kind: 'app-running', packageName: 'com.android.systemui' } }));
      const decision = await invoke(['adjudicate-task', task.id, decisionPath]);
      const expectation = { decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256, leaseToken: retained.lease.token };
      const expectationPath = join(directory, 'expectation.json');
      await writeFile(expectationPath, JSON.stringify(expectation));
      const preparation = await invoke(['prepare-adjudicated-task', task.id, expectationPath]);
      const receiptPath = join(directory, 'receipt.json');
      await writeFile(receiptPath, JSON.stringify({ ...expectation, preparationId: preparation.claim.id,
        preparationDigestSha256: preparation.preparationDigestSha256 }));
      const reserved = await invoke(['reserve-adjudicated-task', task.id, receiptPath]);
      let conflictEvidence;
      if (fileConflict) {
        const conflictContent = 'External edit after worker crash: do not overwrite.';
        const conflictLocal = join(directory, 'fixture-external-edit.txt');
        await writeFile(conflictLocal, conflictContent);
        const reservedTaskPath = join(store.directory, reserved.task.id, 'task.json');
        const taskBefore = await readFile(reservedTaskPath, 'utf8');
        const leaseBefore = await inspectDeviceLock(deviceId);
        assert.equal(leaseBefore.owner, 'dead');
        await adb('push', conflictLocal, fixturePath);
        await assert.rejects(invoke(['continue-adjudicated-task', task.id, receiptPath]), /Environment recovery incomplete/);
        assert.equal(await adb('exec-out', 'cat', fixturePath), conflictContent, 'Recovery must preserve external content');
        assert.deepEqual(await inspectDeviceLock(deviceId), leaseBefore, 'Cleanup failure must retain the exact abandoned lease');
        assert.equal(await readFile(reservedTaskPath, 'utf8'), taskBefore, 'Failed cleanup must not claim or modify the reservation');
        const queued = JSON.parse(taskBefore);
        assert.equal(queued.status, 'queued');
        assert.equal(queued.runDirectory, undefined);
        const summary = JSON.parse(await readFile(join(task.runDirectory, 'fixtures/summary.json'), 'utf8'));
        assert.equal(summary.entries[0].restored, false);
        assert.match(summary.entries[0].error, /changed outside preparation/);
        conflictEvidence = { status: 'rejected-without-overwrite', leaseToken: leaseBefore.lease.token,
          successorTaskId: queued.id, successorStatus: queued.status, fixtureSummary: summary };
        await writeFile(join(directory, 'file-conflict-verification.json'), JSON.stringify(conflictEvidence, null, 2));
        // Undo only the edit this verifier injected, after checking it is unchanged.
        assert.equal(await adb('exec-out', 'cat', fixturePath), conflictContent);
        const preparedLocal = join(directory, 'fixture-prepared.txt');
        await writeFile(preparedLocal, preparedContent);
        await adb('push', preparedLocal, fixturePath);
      }
      let restartSource;
      let continued;
      let repeatedLineage;
      if (transferBeforeBind) {
        const code = `
          import { TaskStore } from ${JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href)};
          import { continueAdjudicatedAndroidTask } from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};
          import { readFile } from 'node:fs/promises';
          await continueAdjudicatedAndroidTask(new TaskStore(${JSON.stringify(store.directory)}), ${JSON.stringify(task.id)}, JSON.parse(await readFile(${JSON.stringify(receiptPath)}, 'utf8')), {
            runFlow: async () => {
              process.send({ taskId: ${JSON.stringify(reserved.task.id)} });
              await new Promise(() => setInterval(() => {}, 1000));
            }
          });`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const exit = once(child, 'exit'); let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
        try {
          const [ready] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(90000) }), exit.then(() => { throw new Error(`Transfer exited before crash: ${errors}`); })]);
          assert.equal(ready.taskId, reserved.task.id);
          const current = await inspectDeviceLock(deviceId);
          assert.equal(current.lease.pid, child.pid);
          assert.equal(current.lease.recoveredFrom.token, expectation.leaseToken);
          assert.equal((await store.get(reserved.task.id)).runDirectory, undefined);
          child.kill('SIGKILL'); await exit;
        } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
        const current = await inspectDeviceLock(deviceId); assert.equal(current.owner, 'dead');
        await assert.rejects(invoke(['continue-adjudicated-task', task.id, receiptPath]), /exact abandoned successor device lease/);
        continued = await invoke(['continue-adjudicated-task', task.id, receiptPath, current.lease.token]);
        await writeFile(join(directory, 'unstarted-transfer.json'), JSON.stringify({ killedLease: current.lease, successorTaskId: reserved.task.id, retriedTaskId: continued.taskId }, null, 2));
      } else if (restartBoundary || repeatAdjudication) {
        const code = `
          import { TaskStore } from ${JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href)};
          import { continueAdjudicatedAndroidTask, runAndroidFlow } from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};
          import { readFile } from 'node:fs/promises';
          const store = new TaskStore(${JSON.stringify(store.directory)});
          let boundary = 0;
          await continueAdjudicatedAndroidTask(store, ${JSON.stringify(task.id)}, JSON.parse(await readFile(${JSON.stringify(receiptPath)}, 'utf8')), {
            runFlow: (device, flow, signal, created, controls) => runAndroidFlow(device, flow, signal, created, {
              ...controls, beforeStep: async () => {
                await controls.beforeStep();
                if (++boundary === 2 && ${!repeatAdjudication}) { process.send({ taskId: ${JSON.stringify(reserved.task.id)} }); await new Promise(() => setInterval(() => {}, 1000)); }
              }
            })
          });`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        const exit = once(child, 'exit'); let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
        try {
          const executing = async () => {
            const deadline = Date.now() + 90000;
            while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
              const candidate = await store.get(reserved.task.id);
              if (candidate.runDirectory) {
                let progress;
                try { progress = JSON.parse(await readFile(join(candidate.runDirectory, 'progress.json'), 'utf8')); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (progress?.phase === 'executing' && progress.active?.step?.description === 'Repeated uncertain wait') {
                  assert.equal(progress.completed.length, 2);
                  assert.equal((await inspectDeviceLock(deviceId)).lease.pid, child.pid);
                  return [{ taskId: candidate.id }];
                }
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Second executing step was not observed');
          };
          const [ready] = await Promise.race([repeatAdjudication ? executing() : once(child, 'message', { signal: AbortSignal.timeout(90000) }), exit.then(() => { throw new Error(`Adjudication exited before crash point: ${errors}`); })]);
          assert.equal(ready.taskId, reserved.task.id);
          child.kill('SIGKILL'); await exit;
        } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
        restartSource = await store.get(reserved.task.id);
        assert.equal(restartSource.status, 'interrupted');
        const current = await inspectDeviceLock(deviceId); assert.equal(current.owner, 'dead');
        const checkpointFile = join(directory, 'restart-checkpoint.json');
        await writeFile(checkpointFile, JSON.stringify({ kind: 'app-running', packageName: 'com.android.systemui' }));
        const restartArgs = ['restart-adjudicated-task', task.id, restartSource.id, receiptPath, current.lease.token, checkpointFile];
        if (repeatAdjudication) {
          await assert.rejects(mcpAdjudication(restartArgs), /phase-executing/);
          const nextPreview = await invoke(['preview-uncertain-task', restartSource.id]);
          assert.equal(nextPreview.completedSteps, 2);
          assert.equal(nextPreview.activeStep.description, 'Repeated uncertain wait');
          const observedPids = await adb('shell', 'pidof', 'com.android.systemui'); assert.match(observedPids.trim(), /^\d+( \d+)*$/);
          const nextDecisionPath = join(directory, 'repeat-decision.json');
          await writeFile(nextDecisionPath, JSON.stringify({ expectedPreviewDigestSha256: nextPreview.previewDigestSha256,
            expectedLeaseToken: current.lease.token, operator: 'emulator-verifier', reason: 'Second interrupted read-only wait; System UI observed running',
            verdict: 'postcondition-verified-skip', postconditionCheckpoint: { kind: 'app-running', packageName: 'com.android.systemui' } }));
          const nextDecision = await invoke(['adjudicate-task', restartSource.id, nextDecisionPath]);
          const nextExpectation = { decisionId: nextDecision.id, previewDigestSha256: nextPreview.previewDigestSha256, leaseToken: current.lease.token };
          const nextExpectationPath = join(directory, 'repeat-expectation.json'); await writeFile(nextExpectationPath, JSON.stringify(nextExpectation));
          const nextPreparation = await invoke(['prepare-adjudicated-task', restartSource.id, nextExpectationPath]);
          const nextReceipt = { ...nextExpectation, preparationId: nextPreparation.claim.id, preparationDigestSha256: nextPreparation.preparationDigestSha256 };
          const nextReceiptPath = join(directory, 'repeat-receipt.json'); await writeFile(nextReceiptPath, JSON.stringify(nextReceipt));
          await invoke(['reserve-adjudicated-task', restartSource.id, nextReceiptPath]);
          continued = await invoke(['continue-adjudicated-task', restartSource.id, nextReceiptPath]);
          repeatedLineage = await readAdjudicatedExecution(store, restartSource.id, continued.taskId, nextReceipt);
        } else if (restartViaMcp) continued = await mcpAdjudication(restartArgs);
        else {
          const response = await cli(restartArgs);
          assert.equal(response.code, 0, response.stderr); continued = JSON.parse(response.stdout);
        }
        if (!repeatAdjudication) assert.equal(continued.sourceTaskId, restartSource.id);
      } else continued = await invoke(['continue-adjudicated-task', task.id, receiptPath]);
      assert.equal(continued.status, 'passed');
      if (!restartBoundary && !repeatAdjudication) assert.equal(continued.taskId, reserved.task.id);
      const finalTask = await store.get(continued.taskId);
      assert.equal(finalTask.status, 'passed');
      const lineage = await readAdjudicatedExecution(store, task.id, restartSource?.id ?? finalTask.id, JSON.parse(await readFile(receiptPath, 'utf8')));
      assert.equal(lineage.resumeAuthorized, false);
      const finalSteps = (await readFile(join(finalTask.runDirectory, 'steps.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
      assert.equal(finalSteps[0].description, restartBoundary ? 'Verify continuation checkpoint' : 'Verify adjudicated postcondition on live device');
      assert(!finalSteps.some(step => step.description === 'Completed Home action'));
      if (repeatAdjudication) {
        assert(!finalSteps.some(step => step.description === 'Remaining Back action' || step.description === 'Repeated uncertain wait'));
        const priorSteps = (await readFile(join(restartSource.runDirectory, 'steps.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
        assert.equal(priorSteps.filter(step => step.description === 'Remaining Back action' && step.status === 'passed').length, 1);
        assert(finalSteps.some(step => step.description === 'Final evidence' && step.status === 'passed'));
      } else assert(finalSteps.some(step => step.description === 'Remaining Back action' && step.status === 'passed'));
      adjudication = { transport: repeatAdjudication ? 'api-crash-mcp-readjudication' : restartViaMcp ? 'api-crash-mcp-restart' : restartBoundary ? 'api-crash-cli-restart' : adjudicateViaMcp ? 'mcp' : 'cli', transferBeforeBind, restartSourceTaskId: restartSource?.id, taskId: finalTask.id, runDirectory: finalTask.runDirectory, status: finalTask.status, lineage, repeatedLineage };
      if (fileFixture) {
        assert.equal(await adb('exec-out', 'cat', fixturePath), originalContent);
        const originalSha256 = createHash('sha256').update(originalContent).digest('hex');
        const fixtureRuns = [message.root, task.runDirectory, ...(restartSource ? [restartSource.runDirectory] : []), finalTask.runDirectory];
        for (const run of fixtureRuns) {
          const summary = JSON.parse(await readFile(join(run, 'fixtures/summary.json'), 'utf8'));
          assert.equal(summary.entries.length, 1);
          assert.equal(summary.entries[0].path, fixturePath);
          assert.equal(summary.entries[0].originalSha256, originalSha256);
          assert.equal(summary.entries[0].restored, true);
        }
        adjudication.fileFixture = { path: fixturePath, originalSha256, restored: true, verifiedRuns: fixtureRuns.length,
          ...(conflictEvidence ? { conflict: conflictEvidence, sameReceiptRetry: 'passed' } : {}) };
        await withDeviceLock(deviceId, async () => {
          assert.equal(await adb('exec-out', 'cat', fixturePath), originalContent);
          await adb('shell', 'rm', fixturePath);
        });
      }
    } else if (mismatch) {
      const retained = await inspectDeviceLock(deviceId); assert.equal(retained.owner, 'dead');
      const recovery = await cli(['recover-flow', deviceId, retained.lease.token]); assert.equal(recovery.code, 0, recovery.stderr);
    }
    assert.equal(await inspectDeviceLock(deviceId), null);
    records.push({ mismatch, cancel, crash, adjudication, sourceTaskId: message.taskId, sourceRun: message.root, taskId: task.id, runDirectory: task.runDirectory, status: task.status, steps: steps.length, mcpPid: result.mcpPid, workerPid: result.workerPid, cancellation: result.cancellation, notification: notification?.path });
    await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: records.length === (cancel || crash ? 1 : 2) ? 'passed' : 'running', transport, records }, null, 2));
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exited; }
  }
}
} catch (error) {
  const lease = await inspectDeviceLock(deviceId).catch(inspectError => ({ error: String(inspectError) }));
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', deviceId,
    transport, cancel, crash, adjudicate, fileFixture, fixturePath: fileFixture ? fixturePath : undefined, records, error: String(error), retainedLease: lease }, null, 2));
  throw error;
}
console.log(JSON.stringify({ status: 'passed', directory, records }, null, 2));
