import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AdbDriver, findNode, runAndroidFlow } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';
import { startAppOps } from '../packages/android/dist/appops-fixture.js';

const serial = process.argv[2]; assert(serial, 'Usage: node scripts/verify-cross-app.mjs <device-id>');
const root = resolve('.appvanta/runs', `cross-app-${Date.now()}`); await mkdir(root, { recursive: true });
const marker = `AppVantaCrossApp${Date.now()}`;
const quicknote = '/storage/emulated/0/Documents/markor/QuickNote.md';
const editor = { kind: 'resource-id', value: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor' };
const nav = name => ({ kind: 'resource-id', value: `net.gsantner.markor:id/nav_${name}` });
const pull = async destination => {
  await promisify(execFile)(process.env.ADB_PATH || 'adb', ['-s', serial, 'pull', quicknote, destination], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return readFile(destination, 'utf8');
};
await withDeviceLock(serial, async () => {
  const storage = await startAppOps([{ packageName: 'net.gsantner.markor', operation: 'MANAGE_EXTERNAL_STORAGE', mode: 'allow' }], serial, root);
  let verification;
  try {
  const driver = new AdbDriver({ artifactsDirectory: join(root, 'preparation') });
  await driver.stopApp(serial, 'net.gsantner.markor');
  await driver.launch(serial, 'net.gsantner.markor');
  const launched = await driver.observe(serial);
  if (await driver.checkCondition(serial, { kind: 'text-visible', text: 'NO THANKS' }, launched)) {
    await driver.execute(serial, { kind: 'tap', target: { kind: 'text', value: 'NO THANKS' } });
  }
  await driver.execute(serial, { kind: 'tap', target: nav('quicknote') });
  let observation = await driver.observe(serial);
  if (await driver.checkCondition(serial, { kind: 'target-visible', target: { kind: 'accessibility-label', value: 'Edit Mode' } }, observation)) {
    await driver.execute(serial, { kind: 'tap', target: { kind: 'accessibility-label', value: 'Edit Mode' } });
    observation = await driver.observe(serial);
  }
  await findNode(observation.uiTreePath, editor);
  await driver.execute(serial, { kind: 'tap', target: nav('notebook') });
  let before = '', existed = true;
  try { before = await pull(join(root, 'quicknote-before.md')); }
  catch (error) {
    if (!String(error.stderr).includes('No such file or directory')) throw error;
    existed = false; await writeFile(join(root, 'quicknote-before.md'), '');
  }
  assert(!before.includes(marker));
  await writeFile(join(root, 'file-before.json'), JSON.stringify({ quicknote, existed }));
  await driver.launch(serial, 'com.android.settings');
  const source = await driver.observe(serial);
  const node = await findNode(source.uiTreePath, { kind: 'text', value: 'Network & internet' });
  const payload = `${marker}\n${node.text}\n`;
  await writeFile(join(root, 'source.json'), JSON.stringify({ source, node, payload }, null, 2));
  const flow = { name: 'Settings information to Markor note', applications: ['com.android.settings', 'net.gsantner.markor'], steps: [
    { description: 'Confirm source data in Settings', launchPackage: 'com.android.settings', assertText: node.text },
    { description: 'Copy observed source text', action: { kind: 'set-clipboard', text: payload } },
    { description: 'Switch to Markor', launchPackage: 'net.gsantner.markor', assertTarget: nav('quicknote') },
    { description: 'Open destination note', action: { kind: 'tap', target: nav('quicknote') }, assertTarget: editor },
    { description: 'Paste cross-app data', action: { kind: 'paste', target: editor }, assertText: marker },
    { description: 'Save note by leaving editor', action: { kind: 'tap', target: nav('notebook') }, assertTarget: nav('quicknote') },
  ] };
  const result = await runAndroidFlow(serial, flow);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  const after = await pull(join(root, 'quicknote-after.md'));
  assert(after.includes(payload), 'Saved note must contain the exact source payload');
  assert.equal(after.split(marker).length - 1, 1, 'Payload must be saved exactly once');
  verification = { status: 'passed', serial, marker, payload, quicknote, flowRun: result.runDirectory, source,
    before: 'quicknote-before.md', after: 'quicknote-after.md',
    limitations: ['Markor onboarding and storage access required', 'Uses AppVanta clipboard bridge', 'Does not test Android share intents or arbitrary app pairs'] };
  } finally { await storage.stop(); }
  await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify({ ...verification, root }, null, 2));
});
