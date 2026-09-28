import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunContext, executeFlow, parseFlow } from '../dist/index.js';

const rule = { description: 'Dismiss known dialog', when: { kind: 'text-visible', text: 'Dialog' }, action: { kind: 'back' } };
const step = { description: 'Submit once', action: { kind: 'input', target: { kind: 'text', value: 'Editor' }, text: 'unique' }, assertText: 'Ready', timeoutMs: 1, recovery: { maxAttempts: 2, rules: [rule] } };
test('recovery schema requires checkpoints, bounded attempts, guards and one operation', () => {
  for (const recovery of [{ maxAttempts: 0, rules: [rule] }, { maxAttempts: 4, rules: [rule] }, { maxAttempts: 1, rules: [] },
    { maxAttempts: 1, rules: [{ ...rule, when: { kind: 'ui-changed' } }] },
    { maxAttempts: 1, rules: [{ ...rule, launchPackage: 'com.test' }] }, { maxAttempts: 1, rules: [{ ...rule, when: {} }] }]) {
    assert.throws(() => parseFlow({ name: 'invalid', steps: [{ ...step, recovery }] }));
  }
  const { assertText, ...noCheckpoint } = step;
  assert.throws(() => parseFlow({ name: 'invalid', steps: [noCheckpoint] }), /checkpoint/);
});

test('recovery observes before guards, never replays original input, enforces bounds and preserves evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-recovery-'));
  try {
    for (const scenario of ['success', 'exhausted', 'unmatched', 'capture-failed', 'cancelled', 'action-failed']) {
      let count = 0, ready = false, input = 0, recovery = 0;
      const controller = new AbortController();
      const driver = {
        name: 'fake',
        observe: async () => {
          count++;
          if (scenario === 'capture-failed' && count >= 4) throw new Error('capture broken');
          const uiTreePath = join(context.rootDirectory, `${scenario}-${count}.xml`);
          await writeFile(uiTreePath, ready ? 'Ready' : 'Dialog');
          return { capturedAt: new Date().toISOString(), uiTreePath, metadata: { count } };
        },
        checkCondition: async (_, condition, observation) => {
          assert.equal(observation.metadata.count, count, 'guard/check must use latest capture');
          return condition.text === 'Dialog' ? scenario !== 'unmatched' : ready;
        },
        execute: async (_, action) => {
          if (action.kind === 'input') { input++; return { success: true }; }
          recovery++;
          if (scenario === 'cancelled') controller.abort();
          if (scenario === 'success') ready = true;
          return { success: scenario !== 'action-failed', message: 'injected action failure' };
        },
      };
      const device = { id: 'fake', name: 'fake', platform: 'android', capabilities: [] };
      const context = await createRunContext({ runsDirectory: root, driver, device });
      const result = await executeFlow({ context, driver, signal: controller.signal, flow: parseFlow({ name: scenario, steps: [step] }) });
      assert.equal(result.status, scenario === 'success' ? 'passed' : scenario === 'cancelled' ? 'cancelled' : 'failed');
      assert.equal(input, 1);
      assert.equal(recovery, ['exhausted', 'action-failed'].includes(scenario) ? 2 : ['unmatched', 'capture-failed'].includes(scenario) ? 0 : 1);
      if (scenario === 'success') {
        assert.match(result.steps[0].message, /Checkpoint failed.*recovered/);
        const events = (await readFile(join(result.runDirectory, 'recovery.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.deepEqual(events.map(e => e.phase), ['observing', 'guard', 'selected', 'passed']);
        for (const path of result.steps[0].evidence) await readFile(join(result.runDirectory, path));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
