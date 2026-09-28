import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const inputs = process.argv.slice(2).map(path => resolve(path));
assert(inputs.length, 'Usage: node scripts/verify-video-content.mjs <mp4> [more-mp4]');
const root = resolve('.appvanta/runs', `video-content-${Date.now()}`); await mkdir(root, { recursive: true });
const exec = promisify(execFile);
const ffprobe = process.env.APPVANTA_FFPROBE || 'ffprobe', ffmpeg = process.env.APPVANTA_FFMPEG || 'ffmpeg';
const options = { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 };
const versions = {};
for (const [name, binary] of [['ffprobe', ffprobe], ['ffmpeg', ffmpeg]]) versions[name] = (await exec(binary, ['-version'], options)).stdout.split(/\r?\n/)[0];
const records = [];
const inspect = async path => {
  const probe = await exec(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path], options);
  assert.equal(probe.stderr.trim(), '', 'Probe reported decode errors');
  const metadata = JSON.parse(probe.stdout), stream = metadata.streams?.[0];
  assert(stream && stream.width > 0 && stream.height > 0, 'Missing video dimensions');
  assert(Number(stream.nb_read_frames) > 0, 'No decoded frames');
  assert(Number(metadata.format.duration) > 0, 'No positive duration');
  assert(/^[1-9][0-9]*\/[1-9][0-9]*$/.test(stream.time_base), 'Invalid source time base');
  const decoded = await exec(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-i', path, '-map', '0:v:0', '-fps_mode', 'passthrough', '-enc_time_base', stream.time_base, '-f', 'null', '-'], options);
  assert.equal(decoded.stderr.trim(), '', 'Full decode reported errors');
  const bytes = await readFile(path);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, metadata, fullDecode: 'passed' };
};
try {
  for (const path of inputs) records.push(await inspect(path));
  const corrupt = join(root, 'truncated.mp4');
  await writeFile(corrupt, (await readFile(inputs[0])).subarray(0, 64));
  await assert.rejects(inspect(corrupt), undefined, 'Truncated MP4 must not pass');
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', versions, records, truncatedRejected: true,
    limitations: ['Decodability is not visual correctness', 'Does not prove uninterrupted recording or requested duration', 'Recovered capture may end before interruption'] }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, records: records.map(({path, metadata}) => ({ path, frames: metadata.streams[0].nb_read_frames, duration: metadata.format.duration })) }, null, 2));
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', versions, records, error: String(error) }, null, 2));
  throw error;
}
