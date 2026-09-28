import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunContext, executeFlow, parseFlow, recordedFlow } from '../dist/index.js';

test('recording preserves actual operation order and checkpoints, including recovery, and rejects damaged runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-recording-'));
  try {
    let ready = false;
    const calls = [];
    const driver = {
      name: 'fake', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }),
      launch: async (_, packageName) => { calls.push({ launchPackage: packageName }); if (packageName === 'com.ready') ready = true; },
      openUrl: async (_, url) => { calls.push({ openUrl: url }); },
      execute: async (_, action) => { calls.push({ action }); return { success: true }; },
      checkCondition: async (_, condition) => condition.text === 'guard' || ready,
    };
    const device = { id: 'fake', name: 'fake', platform: 'android', capabilities: [] };
    const flow = parseFlow({ name: 'record', steps: [{ description: 'input', launchPackage: 'com.start', openUrl: 'https://example.com', action: { kind: 'input', target: { kind: 'resource-id', value: 'com.start:id/edit', occurrence: 1 }, text: '中文\n%s' }, assertText: 'Ready', timeoutMs: 1,
      recovery: { maxAttempts: 1, rules: [{ description: 'recover', when: { kind: 'text-visible', text: 'guard' }, launchPackage: 'com.ready' }] } }] });
    const context = await createRunContext({ runsDirectory: root, driver, device });
    const result = await executeFlow({ context, driver, flow });
    assert.equal(result.status, 'passed');
    const recording = await recordedFlow(result.runDirectory);
    assert.equal(recording.steps.length, 5);
    assert.deepEqual(recording.steps.slice(0, 4).map(({ description, ...operation }) => operation), calls);
    assert.equal(recording.steps[4].assertText, 'Ready');
    assert(!recording.steps.some(step => step.recovery));
    const before = structuredClone(calls); calls.length = 0; ready = false;
    const replayContext = await createRunContext({ runsDirectory: root, driver, device });
    assert.equal((await executeFlow({ context: replayContext, driver, flow: recording })).status, 'passed');
    assert.deepEqual(calls, before);
    const actions = join(result.runDirectory, 'actions.jsonl');
    const original = await readFile(actions, 'utf8');
    await writeFile(actions, original.split('\n').slice(0, -3).join('\n'));
    await assert.rejects(recordedFlow(result.runDirectory), /integrity/);
    await writeFile(actions, original);
    const runPath = join(result.runDirectory, 'run.json');
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    await writeFile(runPath, JSON.stringify({ ...run, status: 'cancelled' }));
    await assert.rejects(recordedFlow(result.runDirectory), /passing runs/);
    ready = false;
    driver.execute = async () => ({ success: false, message: 'acknowledgement lost' });
    const uncertainContext = await createRunContext({ runsDirectory: root, driver, device });
    const uncertain = await executeFlow({ context: uncertainContext, driver, flow });
    assert.equal(uncertain.status, 'passed', 'checkpoint recovered despite uncertain original action');
    await assert.rejects(recordedFlow(uncertain.runDirectory), /failed or out-of-order/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
