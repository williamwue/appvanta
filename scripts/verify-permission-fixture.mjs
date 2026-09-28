import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parsePermissionSnapshot } from '../packages/android/dist/permission-fixture.js';
import { runAndroidFlow } from '../packages/android/dist/flow.js';

const device = process.argv[2];
assert(device, 'Specify device');
const root = resolve('.appvanta/runs', `permission-fixture-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const run = (file, args, timeout = 120000) => promisify(execFile)(file, args, { encoding: 'utf8', timeout, windowsHide: true });
await run('python', ['scripts/build-input-ime.py']);
await run('adb', ['-s', device, 'install', '-r', '.appvanta/input-ime/appvanta-input.apk']);

const packageName = 'dev.appvanta.input';
const permission = 'android.permission.CAMERA';
const shell = async (...args) => (await run('adb', ['-s', device, 'shell', ...args], 20000)).stdout.trim();
const userId = Number(await shell('am', 'get-current-user'));
assert(Number.isSafeInteger(userId) && userId >= 0);
const state = async () => parsePermissionSnapshot(await shell('dumpsys', 'package', packageName), packageName, permission, userId);
const original = await state();
const requested = original.granted ? 'deny' : 'grant';
const records = [];

for (const scenario of ['passed', 'failed', 'cancelled']) {
  const controller = new AbortController();
  let observer;
  const result = await runAndroidFlow(device, {
    name: `Runtime permission ${scenario}`,
    permissions: [{ packageName, permission, state: requested }],
    steps: [{ description: 'Check prepared permission', action: { kind: 'wait', condition: { kind: 'app-running', packageName: scenario === 'passed' ? 'com.android.systemui' : 'appvanta.nonexistent' }, timeoutMs: scenario === 'cancelled' ? 30000 : 1000 } }],
  }, controller.signal, async directory => {
    observer = (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        let started = false;
        try { started = (await readFile(join(directory, 'actions.jsonl'), 'utf8')).includes('started'); } catch {}
        if (started) {
          assert.equal((await state()).granted, requested === 'grant');
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
  const evidence = JSON.parse(await readFile(join(result.runDirectory, 'fixtures/permissions.json'), 'utf8'));
  assert(evidence.entries.every(entry => entry.restored));
  const environment = JSON.parse(await readFile(join(result.runDirectory, 'environment.json'), 'utf8'));
  assert.deepEqual(environment.permissions, [{ packageName, permission, userId, ...original }]);
  records.push({ scenario, result, evidence });
}

await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', original, requested, records }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
