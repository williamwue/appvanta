import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeBoundaryFrames, decodeClockPng, encodeClockBytes, measureVideos } from '../measure-segment-clock.mjs';
import { installClockFixture, requireMeasuredClock } from '../verify-segmented-recording.mjs';

const { PNG } = createRequire(import.meta.url)('pngjs');
const cli = fileURLToPath(new URL('../measure-segment-clock.mjs', import.meta.url));

function framePng(tick, frame) {
  const bytes = encodeClockBytes(tick, frame), png = new PNG({ width: 512, height: 512 });
  for (let row = 0; row < 16; row++) for (let col = 0; col < 16; col++) {
    let value = (bytes[(row % 8) * 2 + Math.floor(col / 8)] >>> (7 - col % 8)) & 1;
    if (row >= 8) value ^= 1;
    for (let y = row * 32; y < (row + 1) * 32; y++) for (let x = col * 32; x < (col + 1) * 32; x++) {
      const offset = (y * 512 + x) * 4;
      png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = value * 255;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const sample = (base, frame) => ({ first: { tickMs: base, frame }, second: { tickMs: base + 33, frame: frame + 2 },
  penultimate: { tickMs: base + 1000, frame: frame + 60 }, last: { tickMs: base + 1033, frame: frame + 62 } });

test('synthetic PNG round trip preserves monotonic tick and draw counter', () => {
  assert.deepEqual(decodeClockPng(framePng(2 ** 32 + 1234, 98765)), { tickMs: 2 ** 32 + 1234, frame: 98765 });
});

test('corrupt inverse and checksum are rejected', () => {
  const png = PNG.sync.read(framePng(1234, 7));
  const paint = (row, col, shade) => {
    for (let y = row * 32; y < (row + 1) * 32; y++) for (let x = col * 32; x < (col + 1) * 32; x++) {
      const offset = (y * 512 + x) * 4;
      png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = shade;
    }
  };
  paint(8, 0, png.data[(16 * 512 + 16) * 4]);
  assert.throws(() => decodeClockPng(PNG.sync.write(png)), /inverse mismatch/);
  const checksum = PNG.sync.read(framePng(1234, 7));
  const at = (6 * 32 + 16) * 512 * 4 + 16 * 4;
  const flipped = 255 - checksum.data[at];
  for (let y = 6 * 32; y < 7 * 32; y++) for (let x = 0; x < 32; x++) {
    const offset = (y * 512 + x) * 4, inverse = ((y + 8 * 32) * 512 + x) * 4;
    for (let channel = 0; channel < 3; channel++) { checksum.data[offset + channel] = flipped; checksum.data[inverse + channel] = 255 - flipped; }
  }
  assert.throws(() => decodeClockPng(PNG.sync.write(checksum)), /checksum mismatch/);
  const ambiguous = PNG.sync.read(framePng(1234, 7));
  const center = (16 * 512 + 16) * 4;
  ambiguous.data[center] = ambiguous.data[center + 1] = ambiguous.data[center + 2] = 128;
  assert.throws(() => decodeClockPng(PNG.sync.write(ambiguous)), /Ambiguous clock cell/);
});

test('three measured boundaries carry bounded quantization and no seamless claim', () => {
  const result = analyzeBoundaryFrames([sample(1000, 0), sample(2100, 66), sample(3200, 132), sample(4300, 198)]);
  assert.doesNotThrow(() => requireMeasuredClock(result, 4));
  assert.equal(result.status, 'measured');
  assert.deepEqual(result.boundaries.map(x => x.sampledSpanMs), [67, 67, 67]);
  assert.deepEqual(result.boundaries[0].sampledSpanRangeMs, [66, 68]);
  assert.equal(result.seamless, false);
});

test('clock acceptance rejects partial or malformed boundary evidence', () => {
  const measured = analyzeBoundaryFrames([sample(1000, 0), sample(2100, 66), sample(3200, 132)]);
  const clone = () => structuredClone(measured);
  const inconclusive = analyzeBoundaryFrames([sample(1000, 0), { error: 'unreadable' }, sample(3200, 132)]);
  assert.throws(() => requireMeasuredClock(inconclusive, 3), /must be measured/);
  const missing = clone(); missing.boundaries.pop();
  assert.throws(() => requireMeasuredClock(missing, 3), /Every segment transition/);
  const reason = clone(); reason.boundaries[1].reason = 'decode failed';
  assert.throws(() => requireMeasuredClock(reason, 3), /inconclusive/);
  const failed = clone(); failed.boundaries[0].status = 'failed';
  assert.throws(() => requireMeasuredClock(failed, 3), /inconclusive/);
  for (const span of [NaN, Infinity, -1, null, '67']) {
    const malformed = clone(); malformed.boundaries[0].sampledSpanMs = span;
    assert.throws(() => requireMeasuredClock(malformed, 3), /invalid sampled span/);
  }
});

test('fixture install has a separate cold-boot timeout and preserves timeout evidence', async () => {
  const calls = [];
  await installClockFixture(async (args, timeout) => { calls.push({ args, timeout }); }, 'fixture.apk');
  assert.deepEqual(calls, [{ args: ['install', '-r', 'fixture.apk'], timeout: 120000 }]);
  const timeout = Object.assign(new Error('killed'), { code: null, killed: true, signal: 'SIGTERM' });
  await assert.rejects(installClockFixture(async () => { throw timeout; }, 'fixture.apk'), error => {
    assert.match(error.message, /timed out after 120000 ms/);
    assert.deepEqual(error.installEvidence, { operation: 'adb-install', apk: 'fixture.apk', timeoutMs: 120000,
      timedOut: true, completionUnconfirmed: true, code: null, signal: 'SIGTERM' });
    return true;
  });
});

test('nonmonotonic clock and implausible adjacent cadence yield inconclusive boundaries', () => {
  const reverse = analyzeBoundaryFrames([sample(1000, 0), sample(1900, 66)]);
  assert.match(reverse.boundaries[0].reason, /nonmonotonic/);
  const bad = sample(2100, 66); bad.second.tickMs = bad.first.tickMs + 500;
  const cadence = analyzeBoundaryFrames([sample(1000, 0), bad]);
  assert.match(cadence.boundaries[0].reason, /cadence invalid/);
  assert.equal(cadence.status, 'inconclusive');
  assert.equal(cadence.maxSampledSpanMs, null);
  const unreadable = analyzeBoundaryFrames([sample(1000, 0), { error: 'CRC mismatch' }, sample(3200, 132)]);
  assert.deepEqual(unreadable.boundaries.map(x => x.status), ['inconclusive', 'inconclusive']);
  assert.match(unreadable.boundaries[0].reason, /CRC mismatch/);
});

test('CLI returns structured inconclusive boundaries for missing MP4 inputs', () => {
  const output = execFileSync(process.execPath, [cli, 'missing-clock-a.mp4', 'missing-clock-b.mp4'], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.seamless, false);
  assert.equal(result.boundaries.length, 1);
  assert.match(result.boundaries[0].reason, /Boundary frame decode failed/);
});

test('ffmpeg samples the actual first and last decoded MP4 frames', async t => {
  try { execFileSync(process.env.APPVANTA_FFMPEG || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync(process.env.APPVANTA_FFPROBE || 'ffprobe', ['-version'], { stdio: 'ignore' }); }
  catch { t.skip('ffmpeg and ffprobe are required'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'appvanta-clock-test-'));
  try {
    const videos = [];
    for (let part = 0; part < 2; part++) {
      const folder = join(dir, `part-${part}`);
      mkdirSync(folder);
      for (let n = 0; n < 4; n++) writeFileSync(join(folder, `${String(n).padStart(2, '0')}.png`), framePng(1000 + part * 200 + n * 33, part * 12 + n * 2));
      const video = join(dir, `${part}.mp4`);
      execFileSync(process.env.APPVANTA_FFMPEG || 'ffmpeg', ['-y', '-v', 'error', '-framerate', '30', '-i', join(folder, '%02d.png'), '-c:v', 'mpeg4', '-q:v', '2', video], { timeout: 30000 });
      videos.push(video);
    }
    const result = await measureVideos(videos);
    assert.equal(result.status, 'measured', JSON.stringify(result));
    assert.equal(result.boundaries[0].sampledSpanMs, 101);
    const cliResult = JSON.parse(execFileSync(process.execPath, [cli, ...videos], { encoding: 'utf8', timeout: 30000 }));
    assert.equal(cliResult.status, 'measured', JSON.stringify(cliResult));
    assert.equal(cliResult.boundaries[0].sampledSpanMs, 101);
    assert.equal(cliResult.seamless, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
