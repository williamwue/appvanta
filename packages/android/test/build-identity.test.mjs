import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectBuildProcessIdentity, validateBuildIdentityObservation } from '../dist/build-identity.js';

test('identity observations require both requested identity fields and consistent states', () => {
  const expected = { pid: 123, startEpochMillis: 1000 };
  const match = { version: 1, pid: 123, expectedStartEpochMillis: 1000, observedStartEpochMillis: 1000, state: 'matching' };
  assert.equal(validateBuildIdentityObservation(match, expected).state, 'matching');
  assert.equal(validateBuildIdentityObservation({ ...match, state: 'different', observedStartEpochMillis: 2000 }, expected).state, 'different');
  for (const state of ['absent', 'unknown']) assert.equal(validateBuildIdentityObservation({ ...match, state, observedStartEpochMillis: null }, expected).state, state);
  for (const change of [{ pid: 124 }, { expectedStartEpochMillis: 1001 }, { observedStartEpochMillis: null },
    { observedStartEpochMillis: 1001 }, { state: 'different' }, { version: 2 }, { state: 'gone' }]) {
    assert.throws(() => validateBuildIdentityObservation({ ...match, ...change }, expected));
  }
  assert.throws(() => validateBuildIdentityObservation(null, expected));
  assert.throws(() => validateBuildIdentityObservation(match, { pid: 0, startEpochMillis: 1000 }));
});

test('identity inspection launch failure remains unknown with a command receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, 'identity.json');
  const result = await inspectBuildProcessIdentity({ java: join(root, 'missing-java'), pid: process.pid, startEpochMillis: 1000, outputPath });
  assert.equal(result.state, 'unknown'); assert.equal(result.observation, null);
  assert.equal(result.command.status, 'launch-failed'); assert.equal(result.command.errorCode, 'ENOENT');
  assert.equal(JSON.parse(await readFile(outputPath + '.log.command.json', 'utf8')).status, 'launch-failed');
  await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
});
