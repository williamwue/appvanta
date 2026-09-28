import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBaseline, compareRuns } from '../dist/index.js';

test('baseline fails closed on missing/invalid data and accepts valid boundary', () => {
  for (const value of [undefined, null, '10', NaN, Infinity, -1]) assert.equal(checkBaseline({ startupMs: 10 }, { startupMs: value }).passed, false);
  for (const limits of [{}, null, [], { startupMs: NaN }, { startupMs: -1 }]) assert.equal(checkBaseline(limits, { startupMs: 1 }).passed, false);
  assert.equal(checkBaseline({ startupMs: 10 }, {}).passed, false);
  assert.equal(checkBaseline({ startupMs: 10 }, { startupMs: 11 }).passed, false);
  assert.equal(checkBaseline({ startupMs: 10 }, { startupMs: 10 }).passed, true);
});

test('comparison detects equal-count failures, missing steps, reordered identities and malformed data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-compare-'));
  try {
    const a = join(root, 'a'), b = join(root, 'b');
    await mkdir(a); await mkdir(b);
    const steps = [{ index: 1, description: 'login', status: 'passed' }, { index: 2, description: 'logout', status: 'passed' }];
    const save = (path, records) => writeFile(join(path, 'steps.jsonl'), records.map(x => JSON.stringify(x)).join('\n'));
    await save(a, steps); await save(b, steps);
    assert.equal((await compareRuns(a, b, { stepsOnly: true })).status, 'passed');
    for (const records of [[steps[0]], [{ ...steps[0], description: 'other' }, steps[1]], [{ ...steps[0], status: 'failed' }, steps[1]], [{ ...steps[0], status: 'skipped' }, steps[1]], []]) {
      await save(b, records);
      assert.equal((await compareRuns(a, b, { stepsOnly: true })).status, 'failed');
    }
    await save(a, [{ ...steps[0], status: 'failed' }]); await save(b, [{ ...steps[0], status: 'failed' }]);
    assert.equal((await compareRuns(a, b, { stepsOnly: true })).status, 'failed');
    await writeFile(join(b, 'steps.jsonl'), 'broken JSON');
    assert.equal((await compareRuns(a, b, { stepsOnly: true })).status, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
