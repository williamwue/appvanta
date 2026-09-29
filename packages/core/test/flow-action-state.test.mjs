import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunContext, executeFlow, parseAction, parseFlow } from '../dist/index.js';

test('shake parsing bounds every control and rejects additional input', () => {
  const action = { kind: 'shake', axis: 'x', amplitude: 12, cycles: 2, intervalMs: 150 };
  assert.deepEqual(parseAction(action), action);
  for (const change of [{ axis: 'w' }, { amplitude: 31 }, { amplitude: NaN }, { cycles: 1.5 }, { cycles: 21 }, { intervalMs: 49 }, { intervalMs: 1001 }, { extra: true }]) assert.throws(() => parseAction({ ...action, ...change }));
});

test('unverified action restoration stops business recovery and marks cleanup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-action-state-'));
  try {
    let actions = 0, restored = 0, observations = 0;
    const driver = { name: 'action-state-test', observe: async () => { observations++; return { capturedAt: new Date().toISOString(), metadata: {} }; },
      checkCondition: async () => true,
      execute: async () => { actions++; throw Object.assign(new Error('Sensor conflict'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); } };
    const context = await createRunContext({ runsDirectory: root, driver, device: { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] } });
    const result = await executeFlow({ context, driver, restoreActionState: async () => { restored++; throw new Error('Conflict retained'); }, flow: parseFlow({ name: 'Unverified sensor', steps: [
      { description: 'Shake', action: { kind: 'shake', axis: 'x', amplitude: 12, cycles: 2, intervalMs: 150 }, assertText: 'Ready', recovery: { maxAttempts: 1, rules: [{ description: 'Must not execute', when: { kind: 'text-visible', text: 'Ready' }, action: { kind: 'back' } }] } },
      { description: 'Must not continue', action: { kind: 'back' } },
    ] }) });
    assert.equal(actions, 1); assert.equal(observations, 1); assert.equal(restored, 1);
    assert.equal(result.status, 'failed'); assert.equal(result.cleanupFailed, true);
    assert(result.steps.some(step => step.description === 'Restore action state' && step.status === 'failed'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
