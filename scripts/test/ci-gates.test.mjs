import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });

test('CLI comparison and baseline gates return failing process codes for invalid evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-gates-'));
  try {
    const before = join(root, 'before'), after = join(root, 'after');
    await mkdir(before); await mkdir(after);
    const step = (description, status = 'passed') => JSON.stringify({ index: 1, description, status }) + '\n';
    await writeFile(join(before, 'steps.jsonl'), step('launch'));
    await writeFile(join(after, 'steps.jsonl'), step('launch'));
    assert.equal(run('compare', before, after, '--steps-only').status, 0);
    for (const content of [step('different'), step('launch', 'failed'), '', '{bad json}']) {
      await writeFile(join(after, 'steps.jsonl'), content);
      const result = run('compare', before, after, '--steps-only');
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, 'failed');
    }
    const baseline = join(root, 'baseline.json'), current = join(root, 'current.json');
    await writeFile(baseline, JSON.stringify({ version: 1, values: { durationMs: 100 } }));
    for (const [values, exit] of [[{ durationMs: 100 }, 0], [{ durationMs: 101 }, 1], [{}, 1], [{ durationMs: '1' }, 1], [null, 1]]) {
      await writeFile(current, JSON.stringify(values));
      const result = run('baseline', baseline, current);
      assert.equal(result.status, exit, result.stderr);
      assert.equal(JSON.parse(result.stdout).passed, exit === 0);
    }
    await writeFile(baseline, '{}');
    assert.equal(run('baseline', baseline, current).status, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
