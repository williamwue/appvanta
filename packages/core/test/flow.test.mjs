import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunContext, executeFlow, parseFlow } from '../dist/index.js';

const definition = { name: 'test', steps: [{ description: 'check', action: { kind: 'back' }, assertText: 'Ready', timeoutMs: 1 }] };
test('Flow schema rejects unsupported versions, empty or misspelled checks and malformed actions', () => {
  assert.equal(parseFlow(definition).version, 1);
  assert.equal(parseFlow({ name: 'echo', steps: [{ description: 'note', echo: 'hello' }] }).steps[0].echo, 'hello');
  assert.equal(parseFlow({ name: 'stable', steps: [{ description: 'stable', action: { kind: 'wait', condition: { kind: 'screen-stable', stableMs: 500 }, timeoutMs: 1000 } }] }).steps[0].action.condition.stableMs, 500);
  assert.equal(parseFlow({ name: 'buttons', steps: [
    { description: 'home', action: { kind: 'button', button: 'home' } },
    { description: 'rotate', action: { kind: 'rotate', orientation: 'landscape-left' } },
    { description: 'hold', action: { kind: 'long-press', target: { kind: 'text', value: 'Item' }, durationMs: 500 } },
  ] }).steps.length, 3);
  assert.equal(parseFlow({ name: 'clipboard', steps: [
    { description: 'set', action: { kind: 'set-clipboard', text: '中文\n🙂' } },
    { description: 'paste', action: { kind: 'paste', target: { kind: 'resource-id', value: 'app:id/editor' } } },
  ] }).steps.length, 2);
  assert.equal(parseFlow({ ...definition, permissions: [{ packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'grant' }] }).permissions[0].state, 'grant');
  assert.deepEqual(parseFlow({ ...definition, resetApplications: ['app.test'] }).resetApplications, ['app.test']);
  for (const files of [[], [{ path: '/data/private.txt', content: '' }], [{ path: '/storage/emulated/0/../private.txt', content: '' }], [{ path: '/storage/emulated/0/a', content: 5 }], [{ path: '/storage/emulated/0/a', content: 'one' }, { path: '/storage/emulated/0/a', content: 'two' }]]) assert.throws(() => parseFlow({ ...definition, files }));
  for (const input of [null, { ...definition, version: 2 }, { ...definition, steps: [] }, { ...definition, steps: [{ description: 'nothing' }] },
    { ...definition, steps: [{ description: 'bad', asertText: 'typo' }] },
    { ...definition, steps: [{ description: 'bad', launchPackage: 'com.test; echo bad' }] },
    { ...definition, steps: [{ description: 'bad', action: { kind: 'tap', target: { kind: 'coordinate', x: NaN, y: 1 } } }] },
    { ...definition, steps: [{ description: 'bad', action: { kind: 'wait', condition: {}, timeoutMs: 100 } }] },
    { ...definition, steps: [{ description: 'bad', action: { kind: 'wait', condition: { kind: 'screen-stable', stableMs: 1000 }, timeoutMs: 500 } }] },
    { ...definition, steps: [{ description: 'bad', action: { kind: 'button', button: 'factory-reset' } }] },
    { ...definition, steps: [{ description: 'bad', action: { kind: 'rotate', orientation: 'diagonal' } }] },
    { ...definition, steps: [{ description: 'bad', action: { kind: 'long-press', target: { kind: 'coordinate', x: 1, y: 1 }, durationMs: 199 } }] },
    { ...definition, steps: [{ description: 'bad', action: { kind: 'set-clipboard', text: 'a\0b' } }] },
    { ...definition, permissions: [] },
    { ...definition, permissions: [{ packageName: 'app.test', permission: 'CAMERA;bad', state: 'grant' }] },
    { ...definition, permissions: [{ packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'allow' }] },
    { ...definition, permissions: [{ packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'grant' }, { packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'deny' }] },
    { ...definition, resetApplications: [] },
    { ...definition, resetApplications: ['app.test', 'app.test'] },
    { ...definition, resetApplications: ['bad;package'] }]) assert.throws(() => parseFlow(input));
});

test('shared runner enforces checks, re-observes failures, propagates action failure and finalizes sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-flow-'));
  try {
    let observations = 0, actions = 0, stopped = 0, artifactRoot;
    const driver = {
      name: 'fake',
      observe: async () => {
        const uiTreePath = join(artifactRoot, `ui-${++observations}.xml`);
        await writeFile(uiTreePath, '<node text="Ready" />');
        return { capturedAt: new Date().toISOString(), uiTreePath, metadata: {} };
      },
      execute: async () => { actions++; return { success: true }; },
      checkCondition: async () => true,
    };
    const device = { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] };
    const run = async (flow = definition, options = {}) => {
      const context = await createRunContext({ runsDirectory: root, driver, device });
      artifactRoot = context.rootDirectory;
      return executeFlow({ context, driver, flow: parseFlow(flow), ...options });
    };
    const success = await run();
    assert.equal(success.status, 'passed');
    const progress = JSON.parse(await readFile(join(success.runDirectory, 'progress.json'), 'utf8'));
    assert.equal(progress.phase, 'finished');
    assert.equal(progress.status, 'passed');
    assert.equal(progress.active, undefined);
    assert.equal(progress.completed.length, 1);
    assert.equal(progress.completed[0].item.flowIndex, 0);
    assert.deepEqual(progress.pending, []);
    assert.equal(JSON.parse(await readFile(join(success.runDirectory, 'flow.json'))).steps[0].action.kind, 'back');
    const echoed = await run({ name: 'echo', steps: [{ description: 'note', echo: 'hello report' }] });
    assert.equal(echoed.status, 'passed'); assert.equal(echoed.steps[0].output, 'hello report');
    assert.match(await readFile(echoed.report, 'utf8'), /## Step output[\s\S]*hello report/);
    const instructionResults = [];
    let drained = false;
    driver.execute = async (_device, action) => { instructionResults.push(action.kind === 'button' ? action.button : action.kind); return { success: true }; };
    const steered = await run(definition, {
      drainInstructions: async () => drained ? [] : (drained = true, [{ id: 'instruction-1', step: { description: 'Injected home', action: { kind: 'button', button: 'home' } } }]),
      finishInstruction: async (id, status) => instructionResults.push(`${id}:${status}`),
    });
    assert.equal(steered.status, 'passed');
    assert.deepEqual(steered.steps.map(step => step.description), ['Injected home', 'check']);
    assert.deepEqual(instructionResults, ['home', 'instruction-1:applied', 'back']);
    const boundaryOrder = [];
    driver.execute = async () => { boundaryOrder.push('action'); return { success: true }; };
    const bounded = await run({ name: 'boundaries', steps: [{ description: 'one', action: { kind: 'back' } }, { description: 'two', action: { kind: 'back' } }] }, { beforeStep: async () => { boundaryOrder.push('boundary'); } });
    assert.equal(bounded.status, 'passed'); assert.deepEqual(boundaryOrder, ['boundary', 'action', 'boundary', 'action']);
    const boundaryCancellation = new AbortController();
    const cancelledAtBoundary = await run(definition, { signal: boundaryCancellation.signal, beforeStep: async () => { boundaryCancellation.abort(new Error('cancelled while paused')); boundaryCancellation.signal.throwIfAborted(); } });
    assert.equal(cancelledAtBoundary.status, 'cancelled'); assert.equal(cancelledAtBoundary.steps[0].description, 'check'); assert.match(cancelledAtBoundary.steps[0].message, /cancelled while paused/);
    const resetOrder = [];
    driver.execute = async () => { resetOrder.push('action'); return { success: true }; };
    const reset = await run({ ...definition, resetApplications: ['app.test'] }, {
      collectEnvironment: async () => { resetOrder.push('environment'); return {}; },
      resetAppData: async packages => { assert.deepEqual(packages, ['app.test']); resetOrder.push('reset'); },
    });
    assert.equal(reset.status, 'passed');
    assert.deepEqual(resetOrder, ['environment', 'reset', 'action']);
    const unsupportedReset = await run({ ...definition, resetApplications: ['app.test'] });
    assert.equal(unsupportedReset.status, 'failed');
    assert.match(unsupportedReset.steps[0].message, /not supported/);
    driver.checkCondition = async () => false;
    const failed = await run();
    assert.equal(failed.status, 'failed');
    assert.match(failed.steps[0].message, /Checkpoint failed/);
    assert.match(failed.steps[0].evidence[0], new RegExp(`ui-${observations}\\.xml`));
    driver.checkCondition = async () => true;
    driver.execute = async () => ({ success: false, message: 'tap rejected' });
    const rejected = await run();
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.steps[0].message, /tap rejected/);
    const network = { python: 'python', mitmdump: 'proxy' };
    const cleaned = await run({ ...definition, network }, { startNetwork: async () => ({ stop: async () => { stopped++; } }) });
    assert.equal(cleaned.status, 'failed'); assert.equal(stopped, 1);
    const cleanupFailure = await run({ ...definition, network }, { startNetwork: async () => ({ stop: async () => { throw new Error('restore failed'); } }) });
    assert.equal(cleanupFailure.cleanupFailed, true);
    assert.equal(cleanupFailure.steps.at(-1).description, 'Finalize network capture');
    const before = actions;
    const startupFailure = await run({ ...definition, network }, { startNetwork: async () => { throw new Error('port occupied'); } });
    assert.equal(startupFailure.status, 'failed'); assert.equal(actions, before);
    const controller = new AbortController();
    driver.execute = async () => { controller.abort(); await delay(10000, undefined, { signal: controller.signal }); return { success: true }; };
    const cancelled = await run({ ...definition, network, steps: [...definition.steps, ...definition.steps] }, { signal: controller.signal, startNetwork: async () => ({ stop: async () => { stopped++; } }) });
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.steps.length, 1); assert.equal(stopped, 2);
    assert.equal(JSON.parse(await readFile(join(cancelled.runDirectory, 'run.json'))).status, 'cancelled');
    assert.equal(JSON.parse((await readFile(join(cancelled.runDirectory, 'audit.jsonl'), 'utf8')).trim()).outcome, 'cancelled');
    const order = [];
    driver.execute = async () => { order.push('action'); return { success: true }; };
    const capture = { screenSeconds: 30, perfettoSeconds: 30 };
    const captured = await run({ ...definition, capture, network }, {
      startNetwork: async () => ({ stop: async () => { order.push('network-stop'); } }),
      startCapture: async () => { order.push('capture-start'); return { markStep: async (index, phase) => { order.push(`${index}-${phase}`); }, stop: async () => { order.push('capture-stop'); throw new Error('collector failed'); } }; },
    });
    assert.equal(captured.status, 'failed');
    assert.equal(captured.cleanupFailed, true);
    assert.deepEqual(order, ['capture-start', '1-begin', 'action', '1-end', 'capture-stop', 'network-stop']);
    assert.equal(captured.steps.at(-1).description, 'Finalize Flow capture');
    const unsupported = await run({ ...definition, capture });
    assert.equal(unsupported.status, 'failed');
    assert.match(unsupported.steps[0].message, /not supported/);
    const diagnosticOrder = [];
    const diagnosed = await run({ ...definition, network, diagnostics: { packages: ['app.test'] } }, {
      startNetwork: async () => ({ stop: async () => { diagnosticOrder.push('network'); throw new Error('network cleanup failed'); } }),
      startDiagnostics: async () => ({ stop: async () => { diagnosticOrder.push('diagnostics'); throw new Error('crash detected'); } }),
    });
    assert.equal(diagnosed.status, 'failed');
    assert.deepEqual(diagnosticOrder, ['network', 'diagnostics']);
    assert.equal(diagnosed.steps.at(-1).description, 'Runtime diagnostics');
    const restored = [];
    const fixtureFailure = await run({ ...definition, files: [{ path: '/storage/emulated/0/test.txt', content: 'test' }] }, {
      startFixtures: async () => ({ stop: async () => { restored.push(true); throw new Error('restore failed'); } }),
    });
    assert.equal(fixtureFailure.status, 'failed');
    assert.equal(fixtureFailure.cleanupFailed, true);
    assert.deepEqual(restored, [true]);
    assert.equal(fixtureFailure.steps.at(-1).description, 'Restore file fixtures');
    const imeFailure = await run({ ...definition, inputMethod: 'app.test/.Ime', files: [{ path: '/storage/emulated/0/test.txt', content: 'test' }] }, {
      startInputMethod: async () => ({ stop: async () => { throw new Error('IME restore failed'); } }),
      startFixtures: async () => ({ stop: async () => { restored.push(true); } }),
    });
    assert.equal(imeFailure.status, 'failed');
    assert.equal(imeFailure.steps.at(-1).description, 'Restore input method');
    assert.equal(restored.length, 2, 'IME cleanup failure must not skip file restoration');
    const appOpFailure = await run({ ...definition, appOps: [{ packageName: 'app.test', operation: 'CAMERA', mode: 'ignore' }] }, {
      startAppOps: async () => ({ stop: async () => { throw new Error('AppOps restore failed'); } }),
    });
    assert.equal(appOpFailure.status, 'failed');
    assert.equal(appOpFailure.steps.at(-1).description, 'Restore AppOps');
    const permissionFailure = await run({ ...definition, permissions: [{ packageName: 'app.test', permission: 'android.permission.CAMERA', state: 'grant' }] }, {
      startPermissions: async () => ({ stop: async () => { throw new Error('permission restore failed'); } }),
    });
    assert.equal(permissionFailure.status, 'failed');
    assert.equal(permissionFailure.steps.at(-1).description, 'Restore runtime permissions');
  } finally { await rm(root, { recursive: true, force: true }); }
});
