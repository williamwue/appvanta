import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRunContext, executeFlow, parseFlow, inspectFlowProgress, recordedFlow, prepareFlowContinuation } from '../dist/index.js';
import { prepareAdjudicatedFlowContinuation } from '../dist/flow-progress.js';

const target = { kind: 'resource-id', value: 'app:id/editor' };
const device = { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] };
const definition = { name: 'Read and reuse', steps: [
  { description: 'Extract', extract: { name: 'note', target, attribute: 'text' } },
  { description: 'Reuse', inputValue: { name: 'note', target } },
] };
for (const mode of ['during-read', 'after-value']) test(`unfinished extraction cannot be silently accepted after actual process crash: ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-value-unfinished-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/value-crash.fixture.mjs', import.meta.url)), root, mode], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(15000) }), exited.then(() => { throw new Error(stderr); })]);
    child.kill('SIGKILL'); await exited;
    const progress = await inspectFlowProgress(message.root);
    assert.equal(progress.phase, 'executing'); assert.equal(progress.completedSteps, 0);
    const receipt = join(message.root, 'value-1.json');
    if (mode === 'during-read') await assert.rejects(readFile(receipt), { code: 'ENOENT' });
    else assert.equal(JSON.parse(await readFile(receipt, 'utf8')).value, 'Persisted 中文\nvalue');
    const original = await readFile(join(message.root, 'progress.json'));
    await assert.rejects(prepareFlowContinuation(message.root, { kind: 'text-visible', text: 'Ready' }), /Unsafe continuation/);
    await assert.rejects(prepareAdjudicatedFlowContinuation(message.root, { kind: 'text-visible', text: 'Ready' }), /unfinished extraction/);
    assert.deepEqual(await readFile(join(message.root, 'progress.json')), original);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
test('extracted Unicode value is persisted, consumed and recorded as the actual input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-values-'));
  try {
    const value = '中文 café\n<>& "'; const actions = [];
    const driver = { name: 'values-test', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }),
      extractValue: async () => value, execute: async (_device, action) => { actions.push(action); return { success: true }; } };
    const context = await createRunContext({ runsDirectory: root, driver, device });
    const report = await executeFlow({ context, driver, flow: parseFlow(definition) });
    assert.equal(report.status, 'passed'); assert.deepEqual(actions, [{ kind: 'input', target, text: value }]);
    assert.equal(report.steps[0].output, value);
    const receipt = JSON.parse(await readFile(join(context.rootDirectory, 'value-1.json'), 'utf8'));
    assert.equal(receipt.value, value);
    assert.equal((await inspectFlowProgress(context.rootDirectory)).completedSteps, 2);
    const replay = await recordedFlow(context.rootDirectory);
    assert.deepEqual(replay.steps.find(step => step.action)?.action, actions[0]);
    await writeFile(join(context.rootDirectory, 'value-1.json'), JSON.stringify({ ...receipt, value: 'changed' }));
    await assert.rejects(inspectFlowProgress(context.rootDirectory));
    await assert.rejects(recordedFlow(context.rootDirectory));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('value schema refuses unsupported targets, mixed operations and invalid seed values', () => {
  for (const step of [
    { ...definition.steps[0], action: { kind: 'back' } },
    { ...definition.steps[0], extract: { name: '../bad', target, attribute: 'text' } },
    { ...definition.steps[0], extract: { name: 'x', target: { kind: 'coordinate', x: 1, y: 2 }, attribute: 'text' } },
    { ...definition.steps[0], extract: { name: 'x', target, attribute: 'unknown' } },
  ]) assert.throws(() => parseFlow({ name: 'bad', steps: [step] }));
  assert.throws(() => parseFlow({ ...definition, values: { note: 12 } }));
  assert.throws(() => parseFlow({ ...definition, values: { note: '\ud800' } }));
});

test('actual process crash preserves completed values without extracting again on continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-value-crash-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/value-crash.fixture.mjs', import.meta.url)), root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(15000) }), exited.then(() => { throw new Error(stderr); })]);
    child.kill('SIGKILL'); await exited;
    const prepared = await prepareFlowContinuation(message.root, { kind: 'text-visible', text: 'Ready' });
    assert.deepEqual(prepared.flow.values, { saved: 'Persisted 中文\nvalue' });
    const actions = [];
    const driver = { name: 'value-resume', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }),
      extractValue: async () => { throw new Error('Must not re-extract'); }, execute: async (_device, action) => { actions.push(action); return { success: true }; } };
    const context = await createRunContext({ runsDirectory: root, driver, device });
    assert.equal((await executeFlow({ context, driver, flow: prepared.flow })).status, 'passed');
    assert.equal(actions.at(-1).text, prepared.flow.values.saved);
    const path = join(message.root, 'value-1.json'); await writeFile(path, (await readFile(path, 'utf8')) + '\n');
    await assert.rejects(prepareFlowContinuation(message.root, { kind: 'text-visible', text: 'Ready' }), /hash mismatch/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});

test('missing, skipped, duplicate and oversized values fail without a dependent input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-values-errors-'));
  try {
    for (const mode of ['missing', 'skipped', 'duplicate', 'oversized', 'capacity']) {
      let actions = 0;
      const driver = { name: mode, observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }),
        checkCondition: async () => false, extractValue: async () => mode === 'oversized' ? 'x'.repeat(24001) : '',
        execute: async () => { actions++; return { success: true }; } };
      const context = await createRunContext({ runsDirectory: root, driver, device });
      const extract = { ...definition.steps[0], ...(mode === 'skipped' ? { when: { kind: 'text-visible', text: 'absent' } } : {}) };
      const flow = parseFlow({ name: mode, ...(mode === 'capacity' ? { values: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`v${i}`, ''])) } : mode === 'duplicate' ? { values: { note: 'existing' } } : {}), steps: mode === 'missing' ? [definition.steps[1]] : [extract, definition.steps[1]] });
      const report = await executeFlow({ context, driver, flow });
      assert.equal(report.status, 'failed', mode); assert.equal(actions, 0, mode);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
