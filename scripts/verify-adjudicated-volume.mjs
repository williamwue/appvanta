import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { TaskStore, inspectDeviceLock, withDeviceLock, previewUncertainTaskStep,
  recordUncertainStepAdjudication, prepareAdjudicatedTaskContinuation,
  reserveAdjudicatedSuccessor, readAdjudicatedExecution } from '../packages/core/dist/index.js';

const deviceId = process.argv[2];
if (!deviceId) throw new Error('Usage: node scripts/verify-adjudicated-volume.mjs <device>');
const root = resolve(import.meta.dirname, '..');
const directory = join(root, '.appvanta/runs', `adjudicated-volume-${Date.now()}`);
await mkdir(directory, { recursive: true });
const store = new TaskStore(join(root, '.appvanta/tasks'));
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', deviceId, ...args], { windowsHide: true, timeout: 15000, encoding: 'utf8' })).stdout;
const volume = async () => {
  const raw = await adb('shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--get');
  const match = raw.match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]/);
  assert(match, raw); return { value: Number(match[1]), min: Number(match[2]), max: Number(match[3]), raw };
};
const core = JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href);
const android = JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href);
async function crashAtMessage(code, inspect) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = once(child, 'exit'); let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(90000) }), exit.then(() => { throw new Error(`Child exited before interruption: ${stderr}`); })]);
    assert.equal((await inspectDeviceLock(deviceId)).lease.pid, child.pid);
    await inspect?.(message);
    child.kill('SIGKILL'); await exit;
    return message;
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
}

let original;
try {
  await withDeviceLock(deviceId, async () => {
    original = await volume();
    assert(original.value < original.max);
    await writeFile(join(directory, 'original-volume.json'), JSON.stringify(original, null, 2));
  });
  const source = await crashAtMessage(`
    import { TaskStore, parseFlow } from ${core};
    import { runAndroidFlow } from ${android};
    const store = new TaskStore(${JSON.stringify(store.directory)});
    const flow = parseFlow({ name: 'Volume side effect', steps: [
      { description: 'Completed Home', action: { kind: 'button', button: 'home' } },
      { description: 'Increase volume once', action: { kind: 'button', button: 'volume-up' } },
      { description: 'Final evidence', echo: 'continued without repeating volume' }
    ] });
    const task = await store.create(${JSON.stringify(deviceId)}, flow); task.status = 'running'; await store.save(task);
    let boundary = 0;
    await runAndroidFlow(task.deviceId, flow, undefined, async run => { task.runDirectory = run; await store.save(task); }, {
      drain: async () => [], finish: async () => {}, beforeStep: async () => {
        if (++boundary === 2) { process.send({ taskId: task.id }); await new Promise(() => setInterval(() => {}, 1000)); }
      }
    });`);
  const abandoned = await inspectDeviceLock(deviceId); assert.equal(abandoned.owner, 'dead');
  let observed;
  const interrupted = await crashAtMessage(`
    import { TaskStore } from ${core};
    import { AdbDriver, continueAndroidTask } from ${android};
    const execute = AdbDriver.prototype.execute;
    AdbDriver.prototype.execute = async function(device, action) {
      const result = await execute.call(this, device, action);
      if (action.kind === 'button' && action.button === 'volume-up') {
        process.send({ action, result }); await new Promise(() => setInterval(() => {}, 1000));
      }
      return result;
    };
    await continueAndroidTask(new TaskStore(${JSON.stringify(store.directory)}), ${JSON.stringify(source.taskId)}, ${JSON.stringify(abandoned.lease.token)}, { kind: 'app-running', packageName: 'com.android.systemui' });`, async () => {
      observed = await volume(); assert.equal(observed.value, original.value + 1, observed.raw);
    });
  const successor = JSON.parse(await readFile(join(store.directory, source.taskId, 'continuation/successor.json'), 'utf8'));
  const preview = await previewUncertainTaskStep(store, successor.taskId);
  assert.equal(preview.activeStep.description, 'Increase volume once');
  assert.equal(preview.completedSteps, 1);
  assert.equal((await volume()).value, original.value + 1);
  const lease = await inspectDeviceLock(deviceId); assert.equal(lease.owner, 'dead');
  await writeFile(join(directory, 'observed-postcondition.json'), JSON.stringify({ original, observed, interrupted, preview }, null, 2));
  const decision = await recordUncertainStepAdjudication(store, successor.taskId, {
    expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lease.lease.token,
    operator: 'emulator-volume-verifier', reason: `Observed music volume increase from ${original.value} to ${observed.value} after driver action returned, before durable completion; skip replay`,
    verdict: 'postcondition-verified-skip', postconditionCheckpoint: { kind: 'app-running', packageName: 'com.android.systemui' },
  });
  const expectation = { decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256, leaseToken: lease.lease.token };
  const preparation = await prepareAdjudicatedTaskContinuation(store, successor.taskId, expectation);
  const receipt = { ...expectation, preparationId: preparation.claim.id, preparationDigestSha256: preparation.preparationDigestSha256 };
  await reserveAdjudicatedSuccessor(store, successor.taskId, receipt);
  const receiptPath = join(directory, 'receipt.json'); await writeFile(receiptPath, JSON.stringify(receipt));
  const executed = await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'continue-adjudicated-task', successor.taskId, receiptPath], { cwd: root, windowsHide: true, timeout: 120000, encoding: 'utf8' });
  const result = JSON.parse(executed.stdout); assert.equal(result.status, 'passed');
  const lineage = await readAdjudicatedExecution(store, successor.taskId, result.taskId, receipt);
  const steps = (await readFile(join(result.runDirectory, 'steps.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert(!steps.some(step => step.description === 'Increase volume once' || step.description === 'Completed Home'));
  assert(steps.some(step => step.description === 'Final evidence' && step.status === 'passed'));
  assert.equal((await volume()).value, original.value + 1, 'Adjudication must not replay volume-up');
  assert.equal(await inspectDeviceLock(deviceId), null);
  await withDeviceLock(deviceId, async () => {
    assert.equal((await volume()).value, original.value + 1, 'Refuse to overwrite an external volume change');
    await adb('shell', 'input', 'keyevent', '25');
    assert.equal((await volume()).value, original.value);
  });
  const evidence = { status: 'passed', deviceId, original, observed, sourceTaskId: source.taskId, interruptedTaskId: successor.taskId, result, lineage, restored: true,
    limitation: 'Verifier pauses after the real driver action returns, before Flow persists completion. Operator independently observes volume; live checkpoint guards System UI, not volume equality. No concurrent external volume writer is simulated.' };
  await writeFile(join(directory, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), original, lease: await inspectDeviceLock(deviceId) }, null, 2));
  throw error;
}
