import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { comparePngScreenshots } from '../dist/index.js';

test('visual diff produces pixel metrics, bounds, tolerance gate and diff PNG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-visual-'));
  try {
    const create = async (name, changed = false, width = 3) => {
      const png = new PNG({ width, height: 2 }); png.data.fill(255);
      if (changed) { const offset = (1 * width + 1) * 4; png.data[offset] = 0; png.data[offset + 1] = 0; png.data[offset + 2] = 0; }
      const path = join(root, name); await writeFile(path, PNG.sync.write(png)); return path;
    };
    const baseline = await create('baseline.png'), current = await create('current.png', true), diff = join(root, 'out/diff.png');
    const failed = await comparePngScreenshots(baseline, current, diff, { channelThreshold: 10, maxMismatchRatio: 0 });
    assert.equal(failed.status, 'failed'); assert.equal(failed.differentPixels, 1); assert.equal(failed.mismatchRatio, 1 / 6); assert.deepEqual(failed.bounds, { left: 1, top: 1, right: 1, bottom: 1 });
    assert.equal(PNG.sync.read(await readFile(diff)).data[16], 255);
    assert.equal((await comparePngScreenshots(baseline, current, diff, { channelThreshold: 255 })).status, 'passed');
    const mask = { x: 1, y: 1, width: 1, height: 1 };
    const masked = await comparePngScreenshots(baseline, current, diff, { ignoreRegions: [mask, mask] });
    assert.equal(masked.status, 'passed');
    assert.equal(masked.ignoredPixels, 1);
    assert.equal(masked.comparedPixels, 5);
    assert.equal(masked.meanChannelDifference, 0);
    assert.deepEqual(masked.ignoreRegions, [mask, mask]);
    const unmaskedChange = await comparePngScreenshots(baseline, current, diff, { ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1 }] });
    assert.equal(unmaskedChange.status, 'failed');
    assert.equal(unmaskedChange.mismatchRatio, 1 / 5);
    for (const ignoreRegions of [[{ x: 0, y: 0, width: 3, height: 2 }], [{ x: 3, y: 0, width: 1, height: 1 }], [{ ...mask, width: 0 }], [{ ...mask, x: 0.5 }], [{ ...mask, extra: true }]]) {
      await assert.rejects(comparePngScreenshots(baseline, current, diff, { ignoreRegions }));
    }
    const dimensions = await comparePngScreenshots(baseline, await create('other.png', false, 2), diff);
    assert.equal(dimensions.status, 'failed'); assert.match(dimensions.reason, /dimensions differ/);
    await assert.rejects(comparePngScreenshots(baseline, current, diff, { maxMismatchRatio: 2 }), /maxMismatchRatio/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('opt-in translation alignment preserves border differences and detects content changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-alignment-'));
  try {
    const baseline = new PNG({ width: 32, height: 32 });
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4;
      baseline.data[i] = (x * 31 + y * 17) % 256;
      baseline.data[i + 1] = (x * 13 + y * 47) % 256;
      baseline.data[i + 2] = (x * 73 + y * 19) % 256; baseline.data[i + 3] = 255;
    }
    const current = new PNG({ width: 32, height: 32 }); current.data.fill(255);
    for (let y = 0; y < 31; y++) for (let x = 0; x < 30; x++) baseline.data.copy(current.data, ((y + 1) * 32 + x + 2) * 4, (y * 32 + x) * 4, (y * 32 + x + 1) * 4);
    const a = join(root, 'a.png'), b = join(root, 'b.png'), diff = join(root, 'diff.png');
    await writeFile(a, PNG.sync.write(baseline)); await writeFile(b, PNG.sync.write(current));
    assert.equal((await comparePngScreenshots(a, b, diff)).status, 'failed');
    const options = { maxAlignmentShift: 3, channelThreshold: 0, maxMismatchRatio: 0.1 };
    const aligned = await comparePngScreenshots(a, b, diff, options);
    assert.equal(aligned.status, 'passed');
    assert.equal(aligned.alignment.dx, 2); assert.equal(aligned.alignment.dy, 1);
    assert.equal(aligned.alignment.unmatchedPixels, 94);
    assert.equal(aligned.differentPixels, 94); assert.equal(aligned.comparedPixels, 1024);
    assert.equal((await comparePngScreenshots(a, b, diff, { ...options, maxMismatchRatio: 0 })).status, 'failed');
    current.data.fill(0, (15 * 32 + 15) * 4, (15 * 32 + 26) * 4);
    await writeFile(b, PNG.sync.write(current));
    assert.equal((await comparePngScreenshots(a, b, diff, options)).status, 'failed');
    for (const maxAlignmentShift of [-1, 1.5, 17, NaN]) await assert.rejects(comparePngScreenshots(a, b, diff, { maxAlignmentShift }), /maxAlignmentShift/);
    const same = await comparePngScreenshots(a, a, diff, options);
    assert.equal(same.alignment.dx, 0); assert.equal(same.alignment.dy, 0); assert.equal(same.status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
