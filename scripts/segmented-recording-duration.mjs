import assert from 'node:assert/strict';
import { resolve } from 'node:path';

function positiveNumber(value, pattern) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !pattern.test(value))) return NaN;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : NaN;
}

export function verifyDecodedMedia(verification, videos, requiredSeconds) {
  assert(Number.isFinite(requiredSeconds) && requiredSeconds > 0, 'Invalid required media duration');
  assert.equal(verification.status, 'passed', 'Strict video verification did not pass');
  assert.equal(verification.truncatedRejected, true, 'Truncated-video rejection did not pass');
  assert.equal(verification.records?.length, videos.length, 'Decoded segment count differs from capture manifest');

  const segments = verification.records.map((record, index) => {
    assert.equal(resolve(record.path), resolve(videos[index]), 'Decoded segment differs from capture manifest');
    assert.equal(record.fullDecode, 'passed', `Segment ${index} did not fully decode`);
    assert(Number.isSafeInteger(record.bytes) && record.bytes > 0, `Segment ${index} is empty`);
    const frames = positiveNumber(record.metadata?.streams?.[0]?.nb_read_frames, /^[0-9]+$/);
    assert(Number.isSafeInteger(frames) && frames > 0, `Segment ${index} has no decoded frames`);
    const duration = positiveNumber(record.metadata?.format?.duration, /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/);
    assert(Number.isFinite(duration) && duration > 0, `Segment ${index} has invalid media duration`);
    return { path: record.path, duration, frames, bytes: record.bytes };
  });
  const mediaSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
  assert(Number.isFinite(mediaSeconds), 'Invalid total media duration');
  if (mediaSeconds < requiredSeconds) {
    const error = new Error(`Decoded media duration ${mediaSeconds.toFixed(6)}s is below required ${requiredSeconds}s`);
    error.mediaSeconds = mediaSeconds;
    error.segments = segments;
    throw error;
  }
  return { mediaSeconds, segments };
}
