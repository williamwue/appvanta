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
    const run = async (definition = step, environment = {}) => {
      const context = await createRunContext({ runsDirectory: root, driver, device });
      return (await executeFlow({ context, driver, flow: parseFlow({ name: 'comparison', steps: [definition] }), collectEnvironment: async () => ({ version: 1, scope: 'declared-applications', host: { node: '22', adb: '35', platform: 'test', arch: 'x64', runtimeSha256: 'a'.repeat(64) }, applications: [{ packageName: 'app.test', installed: true, apks: [{ name: 'base.apk', sha256: 'b'.repeat(64) }] }], ...environment }) })).runDirectory;
    };
    const a = await run(), b = await run();
    assert.equal((await compareRuns(a, b)).status, 'passed');
    assert.equal((await compareRuns(a, b)).scope, 'run');
    for (const environment of [
      { inputMethod: { userId: 0, selected: 'app.ime/.Service', enabled: ['app.ime/.Service'] } },
      { files: [{ path: '/sdcard/fixture.txt', exists: true, sha256: 'c'.repeat(64) }] },
      { appOps: [{ userId: 0, packageName: 'app.test', operation: 'CAMERA', mode: 'allow' }] },
      { permissions: [{ userId: 0, packageName: 'app.test', permission: 'android.permission.CAMERA', granted: true, flags: [] }] },
    ]) {
      const other = await run(step, environment);
      assert.equal((await compareRuns(a, other)).status, 'failed', `Must compare ${Object.keys(environment)[0]}`);
      assert.equal((await compareRuns(other, await run(step, environment))).status, 'passed');
    }
    for (const environment of [
      { files: [{ path: '/sdcard/fixture.txt', exists: true }] },
      { appOps: [{ userId: 0, packageName: 'app.test', operation: 'CAMERA', mode: 'unknown' }] },
      { inputMethod: { userId: 0, selected: 'app.ime/.Service', enabled: null } },
      { permissions: [{ userId: 0, packageName: 'app.test', permission: 'android.permission.CAMERA', granted: true, flags: null }] },
    ]) {
      const invalid = await run(step, environment);
      assert.equal((await compareRuns(invalid, invalid)).status, 'failed', 'Malformed evidence cannot compare equal');
    }
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
