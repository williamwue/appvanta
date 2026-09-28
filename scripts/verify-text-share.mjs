import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AdbDriver, runAndroidFlow } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const serial = process.argv[2]; assert(serial, 'Usage: node scripts/verify-text-share.mjs <device-id>');
const root = resolve('.appvanta/runs', `text-share-${Date.now()}`); await mkdir(root, { recursive: true });
const marker = `AppVantaShare${Date.now()}`;
const text = `${marker}\n中文🙂 'quoted' "double" $(echo bad); %s\nsecond line`;
let result, destination;
await withDeviceLock(serial, async () => {
  const driver = new AdbDriver({ artifactsDirectory: join(root, 'preparation') });
  await driver.stopApp(serial, 'net.gsantner.markor');
  result = await runAndroidFlow(serial, {
    name: 'Native text sharing into Markor', applications: ['net.gsantner.markor'],
    appOps: [{ packageName: 'net.gsantner.markor', operation: 'MANAGE_EXTERNAL_STORAGE', mode: 'allow' }],
    steps: [
      { description: 'Share exact text into local Markor', action: { kind: 'share-text', text, packageName: 'net.gsantner.markor' }, assertText: marker },
      { description: 'Append shared text to QuickNote', action: { kind: 'tap', target: { kind: 'text', value: 'QuickNote' } } },
    ],
  });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  destination = join(root, 'quicknote-after.md');
  await promisify(execFile)(process.env.ADB_PATH || 'adb', ['-s', serial, 'pull', '/storage/emulated/0/Documents/markor/QuickNote.md', destination], { windowsHide: true, timeout: 20000 });
  const saved = await readFile(destination, 'utf8');
  assert(saved.includes(text), 'Saved file must contain the exact multiline Unicode and shell metacharacters');
  assert.equal(saved.split(marker).length - 1, 1);
});
  const failed = await runAndroidFlow(serial, { name: 'Unavailable share target', steps: [
    { description: 'Reject unavailable receiver', action: { kind: 'share-text', text: marker, packageName: 'invalid.appvanta.missing' } },
    { description: 'Must not execute after failed share', action: { kind: 'back' } },
  ] });
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  const steps = (await readFile(join(failed.runDirectory, 'steps.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(steps.length, 1);
  const verification = { status: 'passed', serial, marker, text, success: result.runDirectory, failure: failed.runDirectory,
    savedFile: destination, limitations: ['API 37 emulator and Markor only', 'Does not cover attachments, arbitrary receiver apps or system chooser'] };
  await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify({ root, ...verification }, null, 2));
