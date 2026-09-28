import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AdbDriver, parseUiTree } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const exec = promisify(execFile), serial = process.argv[2]; assert(serial, 'Usage: node scripts/verify-android-actions.mjs <device-id>');
const root = resolve('.appvanta/runs', `android-actions-${Date.now()}`); await mkdir(root, { recursive: true });
const driver = new AdbDriver({ artifactsDirectory: join(root, 'artifacts') }), delay = ms => new Promise(done => setTimeout(done, ms));
const shell = async (...args) => (await exec('adb', ['-s', serial, 'shell', ...args], { encoding: 'utf8', timeout: 20000 })).stdout.trim();
const launchSettingsHome = async () => {
  await shell('am', 'force-stop', 'com.android.settings'); await shell('am', 'force-stop', 'com.google.android.settings.intelligence');
  await shell('am', 'start', '-W', '-n', 'com.android.settings/.homepage.SettingsHomepageActivity');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const observation = await driver.observe(serial), xml = await readFile(observation.uiTreePath, 'utf8'); if (xml.includes('com.android.settings:id/search_action_bar')) return; await delay(250); }
  throw new Error('Settings home did not expose search_action_bar');
};

await withDeviceLock(serial, async () => {
  const originalRotation = await shell('cmd', 'window', 'user-rotation');
  const originalVolumeOutput = await shell('cmd', 'media_session', 'volume', '--stream', '3', '--get');
  const originalVolume = /volume is (\d+)\b/.exec(originalVolumeOutput)?.[1];
  assert(originalVolume, `Cannot parse original media volume: ${originalVolumeOutput}`);
  const actions = [];
  try {
    for (const [orientation, expected] of [['portrait', 'lock 0'], ['landscape-left', 'lock 1'], ['portrait-upside-down', 'lock 2'], ['landscape-right', 'lock 3']]) {
      await driver.execute(serial, { kind: 'rotate', orientation }); const actual = await shell('cmd', 'window', 'user-rotation');
      assert.equal(actual, expected); actions.push({ kind: 'rotate', orientation, actual });
    }

    await launchSettingsHome();
    await driver.execute(serial, { kind: 'long-press', target: { kind: 'resource-id', value: 'com.android.settings:id/search_action_bar' }, durationMs: 800 });
    actions.push({ kind: 'long-press', target: 'com.android.settings:id/search_action_bar', acknowledged: true });

    await launchSettingsHome();
    await driver.execute(serial, { kind: 'tap', target: { kind: 'resource-id', value: 'com.android.settings:id/search_action_bar' } }); await delay(500);
    const clipboardText = `AppVanta 中文 🙂 ${Date.now()}`;
    await driver.execute(serial, { kind: 'set-clipboard', text: clipboardText });
    await driver.execute(serial, { kind: 'paste', target: { kind: 'resource-id', value: 'com.google.android.settings.intelligence:id/open_search_view_edit_text' } }); await delay(500);
    const pasted = await driver.observe(serial), tree = parseUiTree(await readFile(pasted.uiTreePath, 'utf8'));
    assert(JSON.stringify(tree).includes(clipboardText), 'Unicode clipboard text was not present after paste');
    actions.push({ kind: 'paste', text: clipboardText, verifiedInUiTree: true, evidence: pasted });

    await driver.execute(serial, { kind: 'button', button: 'back' }); await delay(500);
    await driver.execute(serial, { kind: 'button', button: 'home' }); await delay(500);
    const homePackage = await driver.getForegroundPackage(serial); assert(homePackage?.includes('launcher'), `Home did not foreground a launcher: ${homePackage ?? 'unknown'}`);
    actions.push({ kind: 'button', button: 'home', foreground: homePackage });
    for (const button of ['app-switch', 'menu', 'enter', 'dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'dpad-center']) { await driver.execute(serial, { kind: 'button', button }); actions.push({ kind: 'button', button, acknowledged: true }); }
    for (const button of ['volume-down', 'volume-up', 'mute', 'mute']) { await driver.execute(serial, { kind: 'button', button }); actions.push({ kind: 'button', button, acknowledged: true }); }

    const beforePower = await shell('dumpsys', 'power'); assert(/mWakefulness=Awake/.test(beforePower));
    await driver.execute(serial, { kind: 'button', button: 'power' }); await delay(800);
    const asleep = await shell('dumpsys', 'power'); assert(/mWakefulness=Asleep/.test(asleep));
    await driver.execute(serial, { kind: 'button', button: 'power' }); await delay(800);
    const awake = await shell('dumpsys', 'power'); assert(/mWakefulness=Awake/.test(awake)); await shell('wm', 'dismiss-keyguard');
    actions.push({ kind: 'button', button: 'power', asleepThenRestored: true });

    await writeFile(join(root, 'verification.json'), `${JSON.stringify({ version: 1, status: 'passed', serial, originalRotation, finishedAt: new Date().toISOString(), actions }, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ status: 'passed', evidence: root, actions: actions.length, clipboardText }));
  } finally {
    await shell('cmd', 'media_session', 'volume', '--stream', '3', '--set', originalVolume);
    const match = /^lock ([0-3])$/.exec(originalRotation); if (match) await shell('cmd', 'window', 'user-rotation', 'lock', match[1]); else await shell('cmd', 'window', 'user-rotation', 'free');
  }
});
