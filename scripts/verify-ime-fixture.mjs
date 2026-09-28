import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAndroidFlow } from '../packages/android/dist/flow.js';
const device = process.argv[2]; assert(device, 'Specify device');
const root = resolve('.appvanta/runs', `ime-fixture-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const shell = async (...args) => (await promisify(execFile)('adb', ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000 })).stdout.trim();
const state = async () => ({ selected: await shell('settings', 'get', 'secure', 'default_input_method'), enabled: (await shell('ime', 'list', '-s')).split(/\r?\n/).sort() });
const original = await state(), component = 'dev.appvanta.input/.InputService';
const records = [];
for (const scenario of ['passed', 'failed', 'cancelled']) {
  const controller = new AbortController();
  let observer;
  const result = await runAndroidFlow(device, { name: `IME ${scenario}`, inputMethod: component, steps: [{ description: 'Check app', action: { kind: 'wait', condition: { kind: 'app-running', packageName: scenario === 'passed' ? 'net.gsantner.markor' : 'appvanta.nonexistent' }, timeoutMs: scenario === 'cancelled' ? 30000 : 1000 } }] }, controller.signal, async directory => {
    observer = (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        let started = false;
        try { started = (await readFile(join(directory, 'actions.jsonl'), 'utf8')).includes('started'); } catch {}
        if (started) {
          assert.equal((await state()).selected, component);
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
  const evidence = JSON.parse(await readFile(join(result.runDirectory, 'fixtures/input-method.json'), 'utf8'));
  assert.equal(evidence.restored, true);
  records.push({ scenario, result, evidence });
}
const missing = await runAndroidFlow(device, { name: 'Missing IME', inputMethod: 'appvanta.nonexistent/.Ime', steps: [{ description: 'Must not run', action: { kind: 'back' } }] });
assert.equal(missing.status, 'failed');
assert.equal((await readFile(join(missing.runDirectory, 'actions.jsonl'), 'utf8')).trim(), '');
assert.deepEqual(await state(), original);
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', original, records, missing }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
