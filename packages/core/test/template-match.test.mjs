import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { findExactPngMatches, findPngMatches, parseTarget } from '../dist/index.js';

test('exact PNG templates return deterministic occurrence centers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-template-'));
  try {
    const screen = new PNG({ width: 7, height: 4 }), template = new PNG({ width: 2, height: 2 });
    screen.data.fill(0); template.data.fill(0);
    for (let pixel = 0; pixel < 4; pixel++) { template.data[pixel * 4] = 255; template.data[pixel * 4 + 3] = 255; }
    for (const origin of [{ x: 1, y: 1 }, { x: 4, y: 1 }]) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const source = (y * 2 + x) * 4, target = ((origin.y + y) * 7 + origin.x + x) * 4;
      template.data.copy(screen.data, target, source, source + 4);
    }
    const screenshot = join(root, 'screen.png'), needle = join(root, 'template.png');
    await Promise.all([writeFile(screenshot, PNG.sync.write(screen)), writeFile(needle, PNG.sync.write(template))]);
    assert.deepEqual((await findExactPngMatches(screenshot, needle)).map(match => match.center), [{ x: 2, y: 2 }, { x: 5, y: 2 }]);
    assert.equal(parseTarget({ kind: 'image-template', path: needle, occurrence: 1 }).occurrence, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PNG templates support explicit channel tolerance and bounded scales', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-template-scale-'));
  try {
    const screen = new PNG({ width: 10, height: 5 }), template = new PNG({ width: 2, height: 2 });
    screen.data.fill(0);
    const colors = [[50, 100, 150], [80, 130, 180], [110, 160, 210], [140, 190, 240]];
    for (let pixel = 0; pixel < 4; pixel++) {
      const offset = pixel * 4, color = colors[pixel]; template.data[offset] = color[0]; template.data[offset + 1] = color[1]; template.data[offset + 2] = color[2]; template.data[offset + 3] = 255;
    }
    for (let y = 1; y < 4; y++) for (let x = 5; x < 8; x++) {
      const color = [50, 100, 150].map(value => value + (x - 5) * 15 + (y - 1) * 30);
      const offset = (y * 10 + x) * 4; screen.data[offset] = color[0] + 4; screen.data[offset + 1] = color[1] - 3; screen.data[offset + 2] = color[2] + 5; screen.data[offset + 3] = 255;
    }
    const screenshot = join(root, 'screen.png'), needle = join(root, 'template.png');
    await Promise.all([writeFile(screenshot, PNG.sync.write(screen)), writeFile(needle, PNG.sync.write(template))]);
    assert.deepEqual((await findPngMatches(screenshot, needle, { maxChannelDelta: 5, scalePercents: [100, 150] })).map(match => match.center), [{ x: 6, y: 2 }]);
    assert.equal((await findPngMatches(screenshot, needle, { maxChannelDelta: 4, scalePercents: [150] })).length, 0);
    assert.deepEqual(parseTarget({ kind: 'image-template', path: needle, maxChannelDelta: 5, scalePercents: [100, 150] }).scalePercents, [100, 150]);
    assert.throws(() => parseTarget({ kind: 'image-template', path: needle, scalePercents: [100, 100] }), /unique/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
