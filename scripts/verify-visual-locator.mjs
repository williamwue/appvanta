import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { AdbDriver, findNode, runAndroidFlow } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const serial = process.argv[2];
assert(serial, 'Usage: node scripts/verify-visual-locator.mjs <device-id>');
const root = resolve('.appvanta/runs', `visual-locator-${Date.now()}`);
await mkdir(root, { recursive: true });
const templatePath = join(root, 'network-row.png');
await withDeviceLock(serial, async () => {
  const driver = new AdbDriver({ artifactsDirectory: join(root, 'source') });
  await driver.launch(serial, 'com.android.settings');
  const observation = await driver.observe(serial);
  const node = await findNode(observation.uiTreePath, { kind: 'text', value: 'Network & internet' });
  const source = PNG.sync.read(await readFile(observation.screenshotPath));
  const { left, top, right, bottom } = node.bounds;
  const crop = new PNG({ width: right - left, height: bottom - top });
  PNG.bitblt(source, crop, left, top, crop.width, crop.height, 0, 0);
  await writeFile(templatePath, PNG.sync.write(crop));
  await writeFile(join(root, 'template-source.json'), JSON.stringify({ observation, node }, null, 2));
});
const target = { kind: 'image-template', path: templatePath };
const passed = await runAndroidFlow(serial, { name: 'Real Settings template click', steps: [
  { description: 'Template is visible', action: { kind: 'wait', condition: { kind: 'target-visible', target }, timeoutMs: 10000 } },
  { description: 'Click Network via pixels', action: { kind: 'tap', target }, assertText: 'Internet' },
  { description: 'Return to source screen', action: { kind: 'back' }, assertTarget: target },
] });
assert.equal(passed.status, 'passed', JSON.stringify(passed));
const templateBytes = await readFile(templatePath);
const sha256 = createHash('sha256').update(templateBytes).digest('hex');
assert.deepEqual(await readFile(join(passed.runDirectory, 'artifacts', `visual-template-${sha256}.png`)), templateBytes);
const missing = new PNG({ width: 17, height: 17 });
for (let offset = 0; offset < missing.data.length; offset += 4) {
  missing.data[offset] = 255; missing.data[offset + 1] = 0; missing.data[offset + 2] = 255; missing.data[offset + 3] = 255;
}
const missingPath = join(root, 'missing.png'); await writeFile(missingPath, PNG.sync.write(missing));
const failed = await runAndroidFlow(serial, { name: 'Missing template fails without tap', steps: [
  { description: 'Missing template', action: { kind: 'tap', target: { kind: 'image-template', path: missingPath } } },
  { description: 'Must not execute', action: { kind: 'back' } },
] });
assert.equal(failed.status, 'failed'); assert.equal(failed.steps.length, 1);
assert.match(failed.steps[0].message, /Image template not found/);
assert(failed.steps[0].evidence.some(path => path.endsWith('.png')));
assert((await readdir(join(failed.runDirectory, 'artifacts'))).some(name => name.startsWith('visual-template-')));
const verification = { status: 'passed', serial, sha256, templatePath, successRun: passed.runDirectory, missingRun: failed.runDirectory,
  checks: ['real screenshot template', 'target-visible', 'pixel-based tap', 'semantic destination checkpoint', 'return assertTarget', 'immutable template copy', 'missing template stops flow'],
  limitations: ['Same DPI and theme', 'No online multi-scale or ambiguity fixture', 'No OCR or VLM'] };
await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
console.log(JSON.stringify({ ...verification, root }, null, 2));
