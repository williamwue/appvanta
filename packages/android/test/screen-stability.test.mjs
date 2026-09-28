import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { AdbDriver } from '../dist/index.js';
import { parseAction } from '../../core/dist/index.js';

test('stable window compares to its anchor and preserves masks and tolerances in evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-stable-'));
  const original = AdbDriver.prototype.observe;
  let index = 0;
  try {
    const images = [];
    for (const [i, value] of [0, 4, 8, 8, 8, 8, 8].entries()) {
      const png = new PNG({ width: 2, height: 1 }); png.data.fill(255);
      png.data[0] = value; png.data[4] = i % 2 ? 0 : 255;
      const path = join(root, `sample-${i}.png`); await writeFile(path, PNG.sync.write(png)); images.push(path);
    }
    AdbDriver.prototype.observe = async () => ({ screenshotPath: images[Math.min(index++, images.length - 1)], capturedAt: new Date().toISOString(), metadata: {} });
    const action = parseAction({ kind: 'wait', timeoutMs: 5000, condition: { kind: 'screen-stable', stableMs: 500, channelThreshold: 5, maxMismatchRatio: 0, ignoreRegions: [{ x: 1, y: 0, width: 1, height: 1 }] } });
    await new AdbDriver({ artifactsDirectory: root }).execute('fake-device', action);
    const comparisons = await Promise.all((await readdir(root)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(root, name), 'utf8'))));
    const drift = comparisons.find(record => record.currentPath === images[2]);
    assert.equal(drift.baselinePath, images[0]);
    assert.equal(drift.comparison.status, 'failed', 'Cumulative drift must restart the stability window');
    assert(comparisons.some(record => record.baselinePath === images[2] && record.comparison.status === 'passed'));
    assert(comparisons.every(record => record.comparison.ignoredPixels === 1 && record.comparison.comparedPixels === 1));
    for (const condition of [{ ...action.condition, channelThreshold: -1 }, { ...action.condition, maxMismatchRatio: 2 }, { ...action.condition, ignoreRegions: [{ x: 0, y: 0, width: 0, height: 1 }] }]) assert.throws(() => parseAction({ ...action, condition }));
  } finally { AdbDriver.prototype.observe = original; await rm(root, { recursive: true, force: true }); }
});
