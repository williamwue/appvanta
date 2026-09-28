import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAndroidFlow } from '../packages/android/dist/flow.js';
const device = process.argv[2]; assert(device, 'Specify device');
const id = Date.now();
const root = resolve('.appvanta/runs', `file-fixtures-check-${id}`);
await mkdir(root, { recursive: true });
const target = `/storage/emulated/0/Download/appvanta-fixture-${id}.txt`, created = target + '.new';
const adb = (...args) => promisify(execFile)('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000 });
const original = Buffer.from([0, 255, 65, 13, 10, 66]);
const seed = join(root, 'original.bin'); await writeFile(seed, original);
await adb('push', seed, target);
const content = '可复现输入 😀\nsecond line\n';
const records = [];
const checkRestored = async () => {
  const pulled = join(root, 'restored.bin'); await adb('pull', target, pulled);
  assert.deepEqual(await readFile(pulled), original);
  assert.equal((await adb('shell', `test ! -e '${created}' && echo absent`)).stdout.trim(), 'absent');
};
try {
  for (const scenario of ['passed', 'failed', 'cancelled']) {
    const controller = new AbortController();
    let observer;
    const result = await runAndroidFlow(device, { name: `Fixture ${scenario}`, applications: ['net.gsantner.markor'], files: [{ path: target, content }, { path: created, content }], steps: [{
      description: 'Check process', launchPackage: 'net.gsantner.markor', action: { kind: 'wait', condition: { kind: 'app-running', packageName: scenario === 'passed' ? 'net.gsantner.markor' : 'appvanta.nonexistent' }, timeoutMs: scenario === 'cancelled' ? 30000 : 1000 },
    }] }, controller.signal, async directory => {
      observer = (async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          let active = false;
          try { active = (await readFile(join(directory, 'actions.jsonl'), 'utf8')).includes('started'); } catch {}
          if (active) {
            const pulled = join(root, `${scenario}.prepared.txt`);
            await adb('pull', target, pulled);
            assert.equal(await readFile(pulled, 'utf8'), content);
            if (scenario === 'cancelled') controller.abort();
            return;
          }
          await delay(50);
        }
        throw new Error('Fixture Flow did not start an action');
      })();
      observer.catch(() => {});
    });
    await observer;
    assert.equal(result.status, scenario, JSON.stringify(result));
    await checkRestored();
    const summary = JSON.parse(await readFile(join(result.runDirectory, 'fixtures/summary.json'), 'utf8'));
    assert(summary.entries.every(entry => entry.restored));
    records.push({ scenario, result, summary });
  }
  const partial = await runAndroidFlow(device, { name: 'Partial fixture setup', files: [{ path: target, content }, { path: `/storage/emulated/0/appvanta-missing-${id}/file.txt`, content }], steps: [{ description: 'Must not execute', action: { kind: 'back' } }] });
  assert.equal(partial.status, 'failed');
  assert.equal((await readFile(join(partial.runDirectory, 'actions.jsonl'), 'utf8')).trim(), '');
  await checkRestored();
  records.push({ scenario: 'partial-setup-rollback', result: partial });
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', records }, null, 2));
} finally { await adb('shell', `rm -f '${target}' '${created}'`); }
console.log(JSON.stringify({ status: 'passed', root }));
