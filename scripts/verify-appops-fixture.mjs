import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAppOpMode, startAppOps } from '../packages/android/dist/appops-fixture.js';
import { runAndroidFlow } from '../packages/android/dist/flow.js';
const device = process.argv[2]; assert(device, 'Specify device');
const root = resolve('.appvanta/runs', `appops-fixture-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const shell = async (...args) => (await promisify(execFile)('adb', ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000 })).stdout.trim();
const packages = ['net.gsantner.markor'];
const operation = 'MANAGE_EXTERNAL_STORAGE';
const state = async () => Promise.all(packages.map(async name => parseAppOpMode(await shell('cmd', 'appops', 'get', name, operation), operation)));
const original = await state();
const appOps = packages.map(packageName => ({ packageName, operation, mode: 'ignore' }));
const records = [];
for (const scenario of ['passed', 'failed', 'cancelled']) {
  const controller = new AbortController();
  let observer;
  const result = await runAndroidFlow(device, { name: `AppOps ${scenario}`, appOps, steps: [{ description: 'Check app', launchPackage: 'net.gsantner.markor', action: { kind: 'wait', condition: { kind: 'app-running', packageName: scenario === 'passed' ? 'net.gsantner.markor' : 'appvanta.nonexistent' }, timeoutMs: scenario === 'cancelled' ? 30000 : 1000 } }] }, controller.signal, async directory => {
    observer = (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        let started = false;
        try { started = (await readFile(join(directory, 'actions.jsonl'), 'utf8')).includes('started'); } catch {}
        if (started) {
          assert.deepEqual(await state(), ['ignore']);
          if (scenario === 'cancelled') controller.abort();
          return;
        }
        await delay(50);
      }
      throw new Error('Flow did not start action');
    })();
    observer.catch(() => {});
  });
  await observer;
  assert.equal(result.status, scenario, JSON.stringify(result));
  assert.deepEqual(await state(), original);
  const evidence = JSON.parse(await readFile(join(result.runDirectory, 'fixtures/appops.json'), 'utf8'));
  assert(evidence.entries.every(entry => entry.restored));
  records.push({ scenario, result, evidence });
}
const missing = await runAndroidFlow(device, { name: 'Unknown AppOp', appOps: [appOps[0], { packageName: packages[0], operation: 'APPVANTA_NONEXISTENT_OP', mode: 'allow' }], steps: [{ description: 'Must not run', action: { kind: 'back' } }] });
assert.equal(missing.status, 'failed');
assert.equal((await readFile(join(missing.runDirectory, 'actions.jsonl'), 'utf8')).trim(), '');
assert.deepEqual(await state(), original);
const audit = (await readFile(join(records[0].result.runDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(audit.filter(event => event.action === 'restore-appop' && event.outcome === 'passed').length, 1);
const outer = await startAppOps([{ packageName: packages[0], operation, mode: 'default' }], device, join(root, 'default-state'));
try {
  const baselineDefault = await state();
  const result = await runAndroidFlow(device, { name: 'Restore default AppOps', appOps, steps: [{ description: 'Check Markor', launchPackage: 'net.gsantner.markor', action: { kind: 'wait', condition: { kind: 'app-running', packageName: packages[0] }, timeoutMs: 1000 } }] });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(await state(), baselineDefault);
  records.push({ scenario: 'default-restoration', result });
} finally { await outer.stop(); }
assert.deepEqual(await state(), original);
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', original, records, missing }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
