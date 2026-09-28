import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeviceLock } from '../packages/core/dist/index.js';
import { startFlowCapture } from '../packages/android/dist/flow-capture.js';
import { verifyDecodedMedia } from './segmented-recording-duration.mjs';
import { measureVideos } from './measure-segment-clock.mjs';

export function requireMeasuredClock(clockMeasurement, segmentCount) {
  assert.equal(clockMeasurement?.status, 'measured', 'Clock measurement must be measured');
  assert(Array.isArray(clockMeasurement.boundaries), 'Clock measurement boundaries required');
  assert.equal(clockMeasurement.boundaries.length, segmentCount - 1, 'Every segment transition must have a measured boundary');
  for (const [index, boundary] of clockMeasurement.boundaries.entries()) {
    assert.equal(boundary.boundary, index + 1, `Clock boundary ${index + 1} index mismatch`);
    assert((boundary.status === undefined || boundary.status === 'measured') && boundary.reason === undefined,
      `Clock boundary ${index + 1} is inconclusive`);
    assert(typeof boundary.sampledSpanMs === 'number' && Number.isFinite(boundary.sampledSpanMs) && boundary.sampledSpanMs >= 0,
      `Clock boundary ${index + 1} has invalid sampled span`);
  }
}

export async function installClockFixture(adb, apk) {
  const timeoutMs = 120000;
  try { await adb(['install', '-r', apk], timeoutMs); }
  catch (error) {
    const timedOut = error.code === 'ETIMEDOUT' || (error.killed === true && error.signal === 'SIGTERM');
    const failure = new Error(timedOut ? `Clock fixture ADB install timed out after ${timeoutMs} ms` : `Clock fixture ADB install failed: ${error.message}`,
      { cause: error });
    failure.installEvidence = { operation: 'adb-install', apk, timeoutMs, timedOut,
      completionUnconfirmed: timedOut, code: error.code ?? null, signal: error.signal ?? null };
    throw failure;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
const device = process.argv[2]; assert(device, 'Device ID required');
const duration = Number(process.argv[3] || 190); assert(Number.isInteger(duration) && duration >= 20 && duration <= 300);
const clockFixture = process.argv[4] === '--clock-fixture';
assert(!process.argv[4] || clockFixture, 'Optional mode must be --clock-fixture');
const segmentSeconds = duration >= 180 ? 60 : 5;
const root = resolve('.appvanta/runs', `segmented-recording-${Date.now()}`); await mkdir(root, { recursive: true });
const exec = promisify(execFile), actions = [];
let decodeVerification;
let clockMeasurement;
try {
await withDeviceLock(device, async () => {
  const adb = (args, timeout = 20000) => exec(process.env.ADB_PATH || 'adb', ['-s', device, ...args], { windowsHide: true, timeout });
  if (clockFixture) {
    const apk = resolve('.appvanta/segment-clock/appvanta-segment-clock.apk');
    await readFile(apk);
    await installClockFixture(adb, apk);
    await adb(['shell', 'am', 'start', '-W', '-n', 'dev.appvanta.segmentclock/.ClockActivity']);
  } else await adb(['shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS']);
  const size = (await adb(['shell', 'wm', 'size'])).stdout.match(/Physical size:\s*(\d+)x(\d+)/); assert(size);
  const x = String(Math.floor(Number(size[1]) / 2)), top = String(Math.floor(Number(size[2]) * .3)), bottom = String(Math.floor(Number(size[2]) * .75));
  const session = await startFlowCapture({ screenSeconds: duration + 60, screenSegmentSeconds: segmentSeconds }, device, root);
  const start = Date.now();
  try {
    while (Date.now() - start < (duration + 12) * 1000) {
      if (clockFixture) { await delay(1000); continue; }
      const from = actions.length % 2 ? top : bottom, to = actions.length % 2 ? bottom : top;
      await adb(['shell', 'input', 'swipe', x, from, x, to, '500']);
      actions.push({ at: new Date().toISOString(), from, to });
    }
  } finally { await session.stop(); await writeFile(join(root, 'actions.json'), JSON.stringify(actions, null, 2)); }
  const manifest = JSON.parse(await readFile(join(root, 'captures/screen-segments.json'), 'utf8'));
  assert.equal(manifest.status, 'passed'); assert.equal(manifest.seamless, false);
  assert(manifest.segments.length >= 3, 'At least three independently finalized segments required');
  const videos = manifest.segments.map(segment => join(root, 'captures', segment.path));
  const decoded = await exec(process.execPath, ['scripts/verify-video-content.mjs', ...videos], { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  const validation = JSON.parse(decoded.stdout);
  decodeVerification = validation.root;
  const decodedEvidence = JSON.parse(await readFile(join(decodeVerification, 'verification.json'), 'utf8'));
  const media = verifyDecodedMedia(decodedEvidence, videos, duration);
  if (clockFixture) {
    clockMeasurement = await measureVideos(videos);
  }
  for (const name of (await readdir(join(root, 'captures'))).filter(name => name.endsWith('.capture.json'))) {
    const record = JSON.parse(await readFile(join(root, 'captures', name), 'utf8'));
    assert.equal(record.cleaned, true); assert.equal(record.status, 'passed');
  }
  if (clockFixture) requireMeasuredClock(clockMeasurement, manifest.segments.length);
  const hostTransitionIntervalsMs = manifest.segments.slice(1).map((segment, index) => Date.parse(segment.readyAt) - Date.parse(manifest.segments[index].finishedAt));
  const result = { status: 'passed', root, duration, segmentSeconds, fixture: clockFixture ? 'segment-clock' : 'settings', manifest, actions: actions.length, mediaSeconds: media.mediaSeconds,
    mediaSegments: media.segments, hostTransitionIntervalsMs, maxStartupGapMs: Math.max(...hostTransitionIntervalsMs), decodeVerification,
    ...(clockFixture ? { clockMeasurement } : {}),
    limitations: ['Segment timestamps use host clock', 'Host transition intervals are not exact media gaps and exclude prior segment finalization and pull time', 'No seamless recording claim'] };
  await writeFile(join(root, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, segments: videos.length, mediaSeconds: media.mediaSeconds, decodeVerification, ...(clockFixture ? { clockMeasurement } : {}) }));
});
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', root, duration, actions: actions.length, decodeVerification,
    ...(clockFixture ? { clockMeasurement } : {}),
    ...(error.mediaSeconds === undefined ? {} : { mediaSeconds: error.mediaSeconds, mediaSegments: error.segments }),
    ...(error.installEvidence ? { installEvidence: error.installEvidence } : {}), error: String(error) }, null, 2));
  throw error;
}
}
