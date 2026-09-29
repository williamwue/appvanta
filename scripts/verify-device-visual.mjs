import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { PNG } from 'pngjs';
import { AdbDriver } from '../packages/android/dist/index.js';
import { comparePngScreenshots, withDeviceLock } from '../packages/core/dist/index.js';

const device = process.argv[2];
assert(device, 'Usage: node scripts/verify-device-visual.mjs <device>');
const root = resolve('.appvanta/runs', `device-visual-${Date.now()}`);
await mkdir(root, { recursive: true });
const exec = promisify(execFile);
const shell = async (...args) => (await exec('adb', ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true })).stdout.trim();
const evidence = await withDeviceLock(device, async () => {
  const driver = new AdbDriver({ artifactsDirectory: join(root, 'artifacts') });
  const environment = { api: await shell('getprop', 'ro.build.version.sdk'), model: await shell('getprop', 'ro.product.model'), density: await shell('wm', 'density') };
  const capture = async () => { await delay(1500); return driver.observe(device); };
  await shell('am', 'start', '-W', '-a', 'android.settings.SETTINGS');
  const baseline = await capture(), repeat = await capture();
  await shell('am', 'start', '-W', '-a', 'android.settings.DISPLAY_SETTINGS');
  const changed = await capture();
  const bytes = await readFile(baseline.screenshotPath);
  const { width, height } = PNG.sync.read(bytes);
  const band = Math.ceil(height * 0.05);
  const ignoreRegions = [{ x: 0, y: 0, width, height: band }, { x: 0, y: height - band, width, height: band }];
  // This fixture isolates SSIM; production pixel thresholds remain caller-controlled.
  const options = { channelThreshold: 16, maxMismatchRatio: 1, minSsim: 0.99, ignoreRegions };
  const comparisons = {};
  for (const [name, observation] of [['repeat', repeat], ['changed', changed]]) {
    comparisons[name] = await comparePngScreenshots(baseline.screenshotPath, observation.screenshotPath, join(root, `${name}-diff.png`), options);
  }
  const captures = [];
  for (const [name, observation] of [['baseline', baseline], ['repeat', repeat], ['changed', changed]]) {
    captures.push({ name, ...observation, sha256: createHash('sha256').update(await readFile(observation.screenshotPath)).digest('hex') });
  }
  const result = { environment, captures, options, comparisons, limitations: ['Single device and Settings screens; no universal perceptual threshold calibration.', 'Top and bottom 5 percent excluded; original PNGs retained.', 'Opens Settings and leaves Display settings visible; no settings values changed.'] };
  await writeFile(join(root, 'measurements.json'), JSON.stringify(result, null, 2));
  assert.equal(comparisons.repeat.status, 'passed', 'Repeated Settings captures must pass the preselected 0.99 SSIM threshold');
  assert.equal(comparisons.changed.status, 'failed', 'Different Settings screens must fail the preselected SSIM threshold');
  assert(comparisons.changed.ssim.score < options.minSsim);
  return result;
});
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, ...evidence }, null, 2));
console.log(JSON.stringify({ status: 'passed', root, scores: Object.fromEntries(Object.entries(evidence.comparisons).map(([key, value]) => [key, value.ssim.score])) }));
