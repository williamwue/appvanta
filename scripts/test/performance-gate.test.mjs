import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI versioned baseline gates emit JSON and nonzero exit on incompatible measurements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-performance-'));
  try {
    const context = { platform: 'android', deviceModel: 'fixture', osVersion: '37', appId: 'app.test', scenario: 'launch', collector: 'fixture', collectorVersion: '1', sampling: { durationMs: 0, iterations: 1, warmupIterations: 0, aggregation: 'single' } };
    const baseline = { version: 2, kind: 'baseline', context, metrics: { duration: { unit: 'ms', max: 100 } } };
    const path = join(root, 'baseline.json'), current = join(root, 'measurement.json');
    await writeFile(path, JSON.stringify(baseline));
    for (const [unit, value, code] of [['ms', 100, 0], ['ms', 101, 1], ['ns', 100, 1]]) {
      await writeFile(current, JSON.stringify({ version: 2, kind: 'measurement', context, metrics: { duration: { unit, value } } }));
      const result = spawnSync(process.execPath, ['packages/cli/dist/index.js', 'baseline', path, current], { encoding: 'utf8' });
      assert.equal(result.status, code, result.stderr);
      const response = JSON.parse(result.stdout); assert.equal(response.version, 2); assert.equal(response.passed, code === 0);
    }
    await writeFile(path, JSON.stringify({ ...baseline, version: 999 }));
    assert.equal(spawnSync(process.execPath, ['packages/cli/dist/index.js', 'baseline', path, current]).status, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
