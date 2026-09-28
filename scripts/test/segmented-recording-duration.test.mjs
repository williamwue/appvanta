import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDecodedMedia } from '../segmented-recording-duration.mjs';

const paths = ['one.mp4', 'two.mp4', 'three.mp4', 'four.mp4'];
const observed = [59.384744, 59.520556, 59.005456, 3.933078];
const verification = durations => ({
  status: 'passed', truncatedRejected: true,
  records: durations.map((duration, index) => ({
    path: paths[index], fullDecode: 'passed', bytes: 1024,
    metadata: { streams: [{ nb_read_frames: '120' }], format: { duration: String(duration) } },
  })),
});

test('the previously accepted 181.843834 seconds cannot satisfy a 190-second request', () => {
  let error;
  try { verifyDecodedMedia(verification(observed), paths, 190); } catch (caught) { error = caught; }
  assert.match(String(error), /181\.843834s is below required 190s/);
  assert.equal(error.mediaSeconds, 181.843834);
});

test('strictly decoded media at or above the requested duration passes', () => {
  assert.equal(verifyDecodedMedia(verification([60, 60, 60, 10]), paths, 190).mediaSeconds, 190);
  assert.equal(verifyDecodedMedia(verification([60, 60, 60, 10.001]), paths, 190).segments.length, 4);
});

test('ffprobe numeric strings and positive JSON numbers remain valid', () => {
  const evidence = verification([60, 60, 60, 10]);
  evidence.records[0].metadata.streams[0].nb_read_frames = 120;
  evidence.records[0].metadata.format.duration = 60;
  evidence.records[1].metadata.format.duration = '6.0e1';
  assert.equal(verifyDecodedMedia(evidence, paths, 190).mediaSeconds, 190);
});

test('non-scalar and malformed frame counts cannot fabricate decoded frames', () => {
  for (const frames of [true, false, null, [120], { count: 120 }, '', ' ', '1.5', '1e2', 'NaN', 'Infinity', '0', '-1', 0, -1, 1.5, Infinity, NaN]) {
    const evidence = verification([60, 60, 60, 60]);
    evidence.records[0].metadata.streams[0].nb_read_frames = frames;
    assert.throws(() => verifyDecodedMedia(evidence, paths, 190), /has no decoded frames/, `frames: ${String(frames)}`);
  }
});

test('non-scalar and malformed durations cannot fabricate media seconds', () => {
  for (const duration of [true, false, null, [60], { duration: 60 }, '', ' ', ' 60', '60 ', 'NaN', 'Infinity', '0', '-1', 0, -1, Infinity, NaN]) {
    const evidence = verification([60, 60, 60, 60]);
    evidence.records[0].metadata.format.duration = duration;
    assert.throws(() => verifyDecodedMedia(evidence, paths, 190), /invalid media duration/, `duration: ${String(duration)}`);
  }
});

test('invalid duration or missing full-decode proof fails closed', () => {
  for (const duration of ['NaN', 'Infinity', '0', '-1', 'unknown']) {
    assert.throws(() => verifyDecodedMedia(verification([60, 60, 60, duration]), paths, 190), /invalid media duration/);
  }
  const incomplete = verification([60, 60, 60, 10]);
  incomplete.records[0].fullDecode = 'failed';
  assert.throws(() => verifyDecodedMedia(incomplete, paths, 190), /did not fully decode/);
});
