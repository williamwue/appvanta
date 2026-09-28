import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { AdbDriver, runAndroidFlow } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const serial = process.argv[2];
assert(serial, 'Usage: node scripts/verify-screen-stability.mjs <device-id>');
const root = resolve('.appvanta/runs', `screen-stability-${Date.now()}`);
await mkdir(root, { recursive: true });
let ignoreRegions;
await withDeviceLock(serial, async () => {
  const driver = new AdbDriver({ artifactsDirectory: join(root, 'initial') });
  await driver.launch(serial, 'com.android.settings');
  const initial = await driver.observe(serial);
  const screenshot = PNG.sync.read(await readFile(initial.screenshotPath));
  ignoreRegions = [{ x: 0, y: 0, width: screenshot.width, height: Math.min(80, screenshot.height - 1) }];
  await writeFile(join(root, 'ignore-regions.json'), JSON.stringify(ignoreRegions));
  await writeFile(join(root, 'initial.json'), JSON.stringify(initial, null, 2));
});
const stableMs = 600;
const passed = await runAndroidFlow(serial, { name: 'Static screen stability', steps: [
  { description: 'Wait for unchanged Settings pixels', action: { kind: 'wait', condition: { kind: 'screen-stable', stableMs, channelThreshold: 2, ignoreRegions }, timeoutMs: 15000 } },
] });
assert.equal(passed.status, 'passed', JSON.stringify(passed));
const samples = [];
for (const name of (await readdir(join(passed.runDirectory, 'artifacts'))).filter(name => name.startsWith('screenshot-') && name.endsWith('.png')).sort()) {
  const content = await readFile(join(passed.runDirectory, 'artifacts', name));
  samples.push({ name, sha256: createHash('sha256').update(content).digest('hex') });
}
assert(samples.length >= 2);
const comparisons = await Promise.all((await readdir(join(passed.runDirectory, 'artifacts'))).filter(name => name.startsWith('stability-') && name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(passed.runDirectory, 'artifacts', name), 'utf8'))));
assert(comparisons.some(record => record.comparison.status === 'passed'));
assert(comparisons.every(record => record.comparison.channelThreshold === 2 && record.comparison.ignoredPixels === ignoreRegions[0].width * ignoreRegions[0].height));
const failed = await runAndroidFlow(serial, { name: 'Insufficient stability window', steps: [
  { description: 'Cannot accumulate full window before deadline', action: { kind: 'wait', condition: { kind: 'screen-stable', stableMs: 5000 }, timeoutMs: 5000 } },
  { description: 'Must not execute after timeout', action: { kind: 'back' } },
] });
assert.equal(failed.status, 'failed');
assert.equal(failed.steps.length, 1);
assert.match(failed.steps[0].message, /Condition timed out/);
assert(failed.steps[0].evidence.some(path => path.endsWith('.png')));
for (const path of failed.steps[0].evidence) assert((await readFile(join(failed.runDirectory, path))).length > 0);
const verification = { status: 'passed', serial, stableMs, successRun: passed.runDirectory, timeoutRun: failed.runDirectory, samples, comparisons, ignoreRegions,
  limitations: ['Explicit rectangular mask only', 'Sampling does not prove stability between captures', 'No perceptual or antialiasing model'] };
await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
console.log(JSON.stringify({ ...verification, root }, null, 2));
