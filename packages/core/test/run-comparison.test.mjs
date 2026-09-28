import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareRuns, createRunContext, executeFlow, parseFlow } from '../dist/index.js';

test('full comparison rejects changed execution, environment and final state despite identical passing step labels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-run-compare-'));
  try {
    const driver = { name: 'fake', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), execute: async () => ({ success: true }), checkCondition: async () => true };
    const device = { id: 'fake', name: 'fake', platform: 'android', kind: 'emulator', model: 'model', osVersion: 'build-A', capabilities: [] };
    const step = { description: 'Same label', action: { kind: 'input', target: { kind: 'text', value: 'Editor' }, text: 'one' }, assertText: 'Ready' };
    const run = async (definition = step) => {
      const context = await createRunContext({ runsDirectory: root, driver, device });
      return (await executeFlow({ context, driver, flow: parseFlow({ name: 'comparison', steps: [definition] }), collectEnvironment: async () => ({ version: 1, scope: 'declared-applications', host: { node: '22', adb: '35', platform: 'test', arch: 'x64', runtimeSha256: 'a'.repeat(64) }, applications: [{ packageName: 'app.test', installed: true, apks: [{ name: 'base.apk', sha256: 'b'.repeat(64) }] }] }) })).runDirectory;
    };
    const a = await run(), b = await run();
    assert.equal((await compareRuns(a, b)).status, 'passed');
    assert.equal((await compareRuns(a, b)).scope, 'run');
    const changed = await run({ ...step, action: { ...step.action, text: 'different' } });
    const mismatch = await compareRuns(a, changed);
    assert.equal(mismatch.status, 'failed');
    assert(mismatch.differences.some(message => message.includes('execution definition')));
    assert(mismatch.differences.some(message => message.includes('operation sequence')));
    assert.equal((await compareRuns(a, changed, { stepsOnly: true })).status, 'passed');
    for (const patch of [{ status: 'cancelled' }, { driver: 'other' }, { finishedAt: 'invalid' }]) {
      const path = join(b, 'run.json'), original = await readFile(path, 'utf8');
      await writeFile(path, JSON.stringify({ ...JSON.parse(original), ...patch }));
      assert.equal((await compareRuns(a, b)).status, 'failed');
      await writeFile(path, original);
    }
    for (const model of [{ ...device, osVersion: 'build-B' }, { ...device, osVersion: '' }, { ...device, kind: 'physical' }]) {
      await writeFile(join(b, 'device.json'), JSON.stringify(model));
      assert.equal((await compareRuns(a, b)).status, 'failed');
    }
    await writeFile(join(b, 'device.json'), JSON.stringify(device));
    await writeFile(join(b, 'actions.jsonl'), '');
    assert.equal((await compareRuns(a, b)).status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
