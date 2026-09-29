import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AdbDriver, parseUiTree } from '../packages/android/dist/index.js';
import { startAppOps } from '../packages/android/dist/appops-fixture.js';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { TaskStore, inspectDeviceLock, withDeviceLock, previewUncertainTaskStep,
  recordUncertainStepAdjudication, prepareAdjudicatedTaskContinuation,
  readAdjudicatedExecution } from '../packages/core/dist/index.js';

const deviceId = process.argv[2];
if (!deviceId || process.argv[3] && process.argv[3] !== 'unicode') throw new Error('Usage: node scripts/verify-adjudicated-input.mjs <device> [unicode]');
const unicode = process.argv[3] === 'unicode';
const root = resolve(import.meta.dirname, '..');
const directory = join(root, '.appvanta/runs', `adjudicated-input-${Date.now()}`);
await mkdir(directory, { recursive: true });
const store = new TaskStore(join(root, '.appvanta/tasks'));
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', deviceId, ...args], { windowsHide: true, timeout: 15000, encoding: 'utf8' })).stdout;
const marker = `AppVantaInput${randomUUID().replaceAll('-', '')}`;
const inputText = unicode ? `${marker} 中文 café\n特殊字符 ' " & < > %s ; $()\n结束` : marker;
const deviceFile = `/storage/emulated/0/Documents/markor/AppVantaNote${randomUUID().replaceAll('-', '')}.txt`;
const original = 'Original standalone verification note.';
const editor = { kind: 'resource-id', value: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor' };
const driver = new AdbDriver({ artifactsDirectory: join(directory, 'observations') });
const contents = () => adb('exec-out', 'cat', deviceFile);
const imeState = async () => ({
  selected: (await adb('shell', 'settings', 'get', 'secure', 'default_input_method')).trim(),
  enabled: (await adb('shell', 'ime', 'list', '-s')).trim().split(/\r?\n/).sort(),
});
const observeWritten = async () => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const observation = await driver.observe(deviceId);
    const xml = await readFile(observation.uiTreePath, 'utf8');
    const nodes = parseUiTree(xml).nodes.filter(node => node.resourceId === editor.value);
    assert.equal(nodes.length, 1, 'Expected one editor');
    const text = nodes[0].text ?? '';
    if (text.includes(marker)) {
      assert.equal(text.split(marker).length - 1, 1);
      assert.equal(text.replace(inputText, ''), original);
      return text;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Input did not appear in the dedicated editor');
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

let storage;
let imeBefore;
try {
  await withDeviceLock(deviceId, async () => {
    imeBefore = await imeState();
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ deviceFile, original, marker, inputText, imeBefore }, null, 2));
    storage = await startAppOps([{ packageName: 'net.gsantner.markor', operation: 'MANAGE_EXTERNAL_STORAGE', mode: 'allow' }], deviceId, directory);
    await driver.stopApp(deviceId, 'net.gsantner.markor');
    const local = join(directory, 'original.txt'); await writeFile(local, original);
    await adb('push', local, deviceFile);
    await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `file://${deviceFile}`, '-t', 'text/plain', '-n', 'net.gsantner.markor/.activity.DocumentActivity');
    await driver.execute(deviceId, { kind: 'wait', condition: { kind: 'target-visible', target: editor }, timeoutMs: 15000 });
    assert.equal(await contents(), original);
  });
  const source = await crashAtMessage(`
    import { TaskStore, parseFlow } from ${core};
    import { runAndroidFlow } from ${android};
    const store = new TaskStore(${JSON.stringify(store.directory)});
    const flow = parseFlow({ name: 'Persistent input side effect', steps: [
      { description: 'Completed editor check', action: { kind: 'wait', condition: { kind: 'target-visible', target: ${JSON.stringify(editor)} }, timeoutMs: 15000 } },
      { description: 'Input marker once', action: { kind: 'input', target: ${JSON.stringify(editor)}, text: ${JSON.stringify(inputText)} } },
      { description: 'Save edited note', action: { kind: 'tap', target: { kind: 'accessibility-label', value: 'Save' } } },
      { description: 'Final evidence', echo: 'continued without repeating input' }
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
      if (action.kind === 'input' && action.text === ${JSON.stringify(inputText)}) {
        process.send({ action, result }); await new Promise(() => setInterval(() => {}, 1000));
      }
      return result;
    };
    await continueAndroidTask(new TaskStore(${JSON.stringify(store.directory)}), ${JSON.stringify(source.taskId)}, ${JSON.stringify(abandoned.lease.token)}, { kind: 'target-visible', target: ${JSON.stringify(editor)} });`, async () => {
      observed = await observeWritten();
      assert.deepEqual(await imeState(), imeBefore, 'Input method must restore before action returns');
    });
  const successor = JSON.parse(await readFile(join(store.directory, source.taskId, 'continuation/successor.json'), 'utf8'));
  const preview = await previewUncertainTaskStep(store, successor.taskId);
  assert.equal(preview.activeStep.description, 'Input marker once');
  assert.equal(preview.completedSteps, 1);
  assert.equal(await observeWritten(), observed);
  const lease = await inspectDeviceLock(deviceId); assert.equal(lease.owner, 'dead');
  await writeFile(join(directory, 'observed-postcondition.json'), JSON.stringify({ original, observed, interrupted, preview }, null, 2));
  const decision = await recordUncertainStepAdjudication(store, successor.taskId, {
    expectedPreviewDigestSha256: preview.previewDigestSha256, expectedLeaseToken: lease.lease.token,
    operator: 'emulator-input-verifier', reason: 'Dedicated editor contains exactly one marker and unchanged original text after real input; skip replay and continue to save',
    verdict: 'postcondition-verified-skip', postconditionCheckpoint: { kind: 'text-visible', text: marker },
  });
  const expectation = { decisionId: decision.id, previewDigestSha256: preview.previewDigestSha256, leaseToken: lease.lease.token };
  const preparation = await prepareAdjudicatedTaskContinuation(store, successor.taskId, expectation);
  const receipt = { ...expectation, preparationId: preparation.claim.id, preparationDigestSha256: preparation.preparationDigestSha256 };
  const receiptPath = join(directory, 'receipt.json'); await writeFile(receiptPath, JSON.stringify(receipt));
  await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'reserve-adjudicated-task', successor.taskId, receiptPath], { cwd: root, windowsHide: true, timeout: 30000, encoding: 'utf8' });
  const executed = await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'continue-adjudicated-task', successor.taskId, receiptPath], { cwd: root, windowsHide: true, timeout: 120000, encoding: 'utf8' });
  const result = JSON.parse(executed.stdout); assert.equal(result.status, 'passed');
  const lineage = await readAdjudicatedExecution(store, successor.taskId, result.taskId, receipt);
  const steps = (await readFile(join(result.runDirectory, 'steps.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert(!steps.some(step => step.description === 'Input marker once' || step.description === 'Completed editor check'));
  assert(steps.some(step => step.description === 'Final evidence' && step.status === 'passed'));
  assert(steps.some(step => step.description === 'Save edited note' && step.status === 'passed'));
  assert.equal(await contents(), observed, 'Adjudication must not repeat input');
  assert.deepEqual(await imeState(), imeBefore);
  assert.equal(await inspectDeviceLock(deviceId), null);
  await withDeviceLock(deviceId, async () => {
    await driver.stopApp(deviceId, 'net.gsantner.markor');
    assert.equal(await contents(), observed, 'Refuse to remove an externally edited note');
    await adb('shell', 'rm', deviceFile);
    await storage.stop();
  });
  const evidence = { status: 'passed', deviceId, deviceFile, unicode, inputText, imeBefore, imeAfter: await imeState(), original, observed, sourceTaskId: source.taskId, interruptedTaskId: successor.taskId, result, lineage, ownedNoteRemoved: true,
    limitation: 'Verifier pauses after the real driver action returns, before Flow persists completion. Persisted note bytes and a live text-visible checkpoint verify the marker. Only this Markor input payload is covered; no concurrent external editor or crash inside the IME bridge is simulated.' };
  await writeFile(join(directory, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  if (storage && !await inspectDeviceLock(deviceId)) await withDeviceLock(deviceId, () => storage.stop());
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), original, lease: await inspectDeviceLock(deviceId) }, null, 2));
  throw error;
}
