import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeviceLock } from '../packages/core/dist/index.js';
import { captureArtifact } from '../packages/android/dist/capture.js';

const device = process.argv[2]; assert(device, 'Device ID required');
const root = resolve('.appvanta/runs', `dynamic-recording-${Date.now()}`); await mkdir(root, { recursive: true });
const exec = promisify(execFile), seconds = 22;
const commands = [];
await withDeviceLock(device, async () => {
  const adb = async args => exec(process.env.ADB_PATH || 'adb', ['-s', device, ...args], { windowsHide: true, timeout: 20000 });
  await adb(['shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS']);
  const size = (await adb(['shell', 'wm', 'size'])).stdout.match(/Physical size:\s*(\d+)x(\d+)/); assert(size);
  const x = String(Math.floor(Number(size[1]) / 2)), top = String(Math.floor(Number(size[2]) * .3)), bottom = String(Math.floor(Number(size[2]) * .75));
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let finished = false;
  const stop = new AbortController();
  const capture = captureArtifact(process.env.ADB_PATH || 'adb', device, root, 'screen', seconds + 5, undefined, { ready, stop: stop.signal })
    .then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
  let timer;
  try {
    await Promise.race([started, capture.then(result => { if (result.error) throw result.error; throw new Error('Capture ended before readiness'); })]);
    timer = setTimeout(() => stop.abort(), seconds * 1000);
    let index = 0;
    while (!finished) {
      const from = index % 2 ? top : bottom, to = index % 2 ? bottom : top;
      const at = new Date().toISOString();
      await adb(['shell', 'input', 'swipe', x, from, x, to, '350']);
      commands.push({ at, from, to }); index++;
      await delay(150);
    }
    const result = await capture; if (result.error) throw result.error;
    await writeFile(join(root, 'actions.json'), JSON.stringify(commands, null, 2));
    const probe = await exec(process.env.APPVANTA_FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-show_format', '-of', 'json', result.value.path], { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(probe.stderr.trim(), '');
    const metadata = JSON.parse(probe.stdout); await writeFile(join(root, 'probe.json'), JSON.stringify(metadata, null, 2));
    const times = metadata.frames.map(frame => Number(frame.best_effort_timestamp_time));
    assert(times.length >= 30, 'Dynamic capture must contain at least 30 frames');
    assert(times.every(Number.isFinite));
    const gaps = times.slice(1).map((time, i) => time - times[i]);
    assert(gaps.every(gap => gap >= 0), 'Frame timestamps must be ordered');
    assert(Number(metadata.format.duration) >= seconds - 2, 'Media duration must cover requested time within 2 seconds');
    assert(Math.max(...gaps) <= 2, 'No frame timestamp gap may exceed 2 seconds');
    await exec(process.execPath, ['scripts/verify-video-content.mjs', result.value.path], { windowsHide: true, timeout: 120000 });
    await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, path: result.value.path, requestedSeconds: seconds, mediaSeconds: Number(metadata.format.duration), frames: times.length, maxFrameGapSeconds: Math.max(...gaps), actions: commands.length, limitations: ['API 37 Settings scroll only', 'Does not prove pixel-level action correspondence or long recording segmentation'] }, null, 2));
    console.log(await readFile(join(root, 'verification.json'), 'utf8')); console.log(root);
  } finally { clearTimeout(timer); stop.abort(); await capture; }
});
