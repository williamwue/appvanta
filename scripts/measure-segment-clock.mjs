import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const { PNG } = createRequire(import.meta.url)('pngjs');
const exec = promisify(execFile);
const limits = { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 };

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeClockBytes(tickMs, frame) {
  if (!Number.isSafeInteger(tickMs) || tickMs < 0 || tickMs >= 2 ** 48 || !Number.isSafeInteger(frame) || frame < 0 || frame > 0xffffffff) throw new Error('Invalid clock value');
  const bytes = Buffer.alloc(16);
  bytes[0] = 0xa6; bytes[1] = 0x5c;
  for (let i = 0; i < 6; i++) bytes[2 + i] = Math.floor(tickMs / 2 ** (40 - 8 * i)) & 255;
  bytes.writeUInt32BE(frame, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 12)), 12);
  return bytes;
}

export function decodeClockPng(buffer) {
  let png;
  try { png = PNG.sync.read(buffer); } catch (error) { throw new Error(`Invalid PNG: ${error.message}`); }
  const side = Math.min(png.width, png.height);
  if (side < 256) throw new Error('Clock grid is below 16 pixels per cell');
  const bytes = Buffer.alloc(16);
  for (let row = 0; row < 16; row++) for (let col = 0; col < 16; col++) {
    const x = Math.floor((col + 0.5) * side / 16), y = Math.floor((row + 0.5) * side / 16);
    const offset = (y * png.width + x) * 4;
    const rgb = [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
    if (Math.max(...rgb) - Math.min(...rgb) > 32 || (Math.min(...rgb) < 80 && Math.max(...rgb) > 175)) throw new Error(`Ambiguous clock cell ${row}:${col}`);
    const value = Math.min(...rgb) > 175 ? 1 : Math.max(...rgb) < 80 ? 0 : -1;
    if (value < 0) throw new Error(`Ambiguous clock cell ${row}:${col}`);
    if (row >= 8) {
      const expected = (bytes[(row - 8) * 2 + Math.floor(col / 8)] >>> (7 - col % 8)) & 1;
      if (value === expected) throw new Error(`Clock inverse mismatch at ${row}:${col}`);
    } else bytes[row * 2 + Math.floor(col / 8)] |= value << (7 - col % 8);
  }
  if (bytes[0] !== 0xa6 || bytes[1] !== 0x5c) throw new Error('Clock magic mismatch');
  if (bytes.readUInt32BE(12) !== crc32(bytes.subarray(0, 12))) throw new Error('Clock checksum mismatch');
  let tickMs = 0;
  for (let i = 2; i < 8; i++) tickMs = tickMs * 256 + bytes[i];
  return { tickMs, frame: bytes.readUInt32BE(8) };
}

export function analyzeBoundaryFrames(segments) {
  if (segments.length < 2) return { status: 'inconclusive', reason: 'At least two clock-coded segments required', seamless: false };
  const boundaries = [];
  for (let i = 0; i < segments.length - 1; i++) {
    try {
      const a = segments[i], b = segments[i + 1];
      if (a.error || b.error) throw new Error(`Boundary frame decode failed: ${a.error || b.error}`);
      for (const [name, pair] of [['outgoing', [a.penultimate, a.last]], ['incoming', [b.first, b.second]]]) {
        const deltaMs = pair[1].tickMs - pair[0].tickMs;
        const frames = pair[1].frame - pair[0].frame;
        if (!(deltaMs > 0 && deltaMs <= 250 && frames > 0 && frames <= 16)) throw new Error(`${name} adjacent frame cadence invalid (${deltaMs} ms, ${frames} draws)`);
      }
      const span = b.first.tickMs - a.last.tickMs;
      if (span <= 0 || b.first.frame <= a.last.frame) throw new Error('Visible clock or draw counter is nonmonotonic across boundary');
      boundaries.push({ boundary: i + 1, sampledSpanMs: span, sampledSpanRangeMs: [Math.max(0, span - 1), span + 1], clockQuantizationUncertaintyMs: 1,
        outgoing: a.last, incoming: b.first, outgoingCadenceMs: a.last.tickMs - a.penultimate.tickMs, incomingCadenceMs: b.second.tickMs - b.first.tickMs });
    } catch (error) {
      boundaries.push({ boundary: i + 1, status: 'inconclusive', reason: String(error.message || error) });
    }
  }
  const valid = boundaries.filter(item => item.sampledSpanMs !== undefined);
  const complete = valid.length === boundaries.length;
  return { status: complete ? 'measured' : 'inconclusive', seamless: false, boundaries,
    maxSampledSpanMs: complete ? Math.max(...valid.map(item => item.sampledSpanMs)) : null,
    maxClockQuantizationUncertaintyMs: complete ? 1 : null,
    limitations: ['Spans compare clock values drawn in sampled decoded frames; they are not exact encoded or display gaps.',
      'Only millisecond clock quantization is bounded; draw-to-display and capture latency are not bounded.',
      'Adjacent-frame checks do not establish continuous capture or seamless recording.'] };
}

async function sampleVideo(path) {
  const probe = await exec(process.env.APPVANTA_FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', path], limits);
  const count = Number(JSON.parse(probe.stdout).streams?.[0]?.nb_read_frames);
  if (!Number.isSafeInteger(count) || count < 4) throw new Error(`${path}: fewer than four decoded frames`);
  const dir = await mkdtemp(join(tmpdir(), 'appvanta-clock-'));
  try {
    const expression = [0, 1, count - 2, count - 1].map(n => `eq(n\\,${n})`).join('+');
    await exec(process.env.APPVANTA_FFMPEG || 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-vf', `select=${expression}`, '-fps_mode', 'passthrough', join(dir, '%02d.png')], limits);
    const files = (await readdir(dir)).filter(name => name.endsWith('.png')).sort();
    if (files.length !== 4) throw new Error(`${path}: expected four exact boundary frames, got ${files.length}`);
    const [first, second, penultimate, last] = await Promise.all(files.map(async name => decodeClockPng(await readFile(join(dir, name)))));
    return { first, second, penultimate, last, decodedFrameCount: count, path };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function measureVideos(paths) {
  if (paths.length < 2) return analyzeBoundaryFrames([]);
  const segments = [];
  for (const path of paths) {
    try { segments.push(await sampleVideo(path)); }
    catch (error) { segments.push({ path, error: String(error.message || error) }); }
  }
  return analyzeBoundaryFrames(segments);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await measureVideos(process.argv.slice(2).map(path => resolve(path)));
  console.log(JSON.stringify(result, null, 2));
}
