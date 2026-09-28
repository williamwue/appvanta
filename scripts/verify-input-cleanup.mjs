import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { inputWithIme } from '../packages/android/dist/input.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const device = process.argv[2];
assert(device, 'Specify device serial');
const exec = promisify(execFile);
const shell = async (...args) => (await exec('adb', ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000 })).stdout.trim();
const root = `.appvanta/runs/input-cleanup-${Date.now()}`;
await mkdir(root, { recursive: true });
await withDeviceLock(device, async () => {
  const state = async () => ({ current: await shell('settings', 'get', 'secure', 'default_input_method'), enabled: await shell('ime', 'list', '-s') });
  const before = await state();
  await assert.rejects(inputWithIme('adb', device, '中文', async () => { throw new Error('injected focus failure'); }), /injected focus failure/);
  assert.deepEqual(await state(), before);
  const controller = new AbortController();
  await assert.rejects(inputWithIme('adb', device, '中文', async () => { controller.abort(); }, controller.signal), /abort/i);
  assert.deepEqual(await state(), before);
  for (const text of ['\ud800', '\0', '中'.repeat(8001)]) {
    await assert.rejects(inputWithIme('adb', device, text, async () => { throw new Error('must not focus'); }), /valid Unicode/);
  }
  await writeFile(`${root}/verification.json`, JSON.stringify({ before, after: await state(), focusFailureRestored: true, cancellationRestored: true, invalidInputRejected: true }, null, 2));
});
console.log(JSON.stringify({ verification: `${root}/verification.json` }));
