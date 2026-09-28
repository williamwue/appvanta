import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
const [verificationPath, python] = process.argv.slice(2);
assert(verificationPath && python, 'Specify Flow capture verification JSON and Perfetto Python executable');
const source = JSON.parse(await readFile(verificationPath, 'utf8'));
const root = resolve('.appvanta/runs', `trace-steps-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const analyze = (trace, output) => spawnSync(python, ['scripts/analyze-perfetto.py', '--trace', trace, '--package', 'net.gsantner.markor', '--output', output], { encoding: 'utf8', timeout: 120000 });
const records = [];
for (const record of source.records.filter(record => record.scenario !== 'expired')) {
  const trace = join(record.result.runDirectory, record.summary.records.find(item => item.kind === 'trace').path);
  const output = join(root, record.scenario);
  const result = analyze(trace, output);
  assert.equal(result.status, 0, result.stderr);
  const analysis = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8'));
  assert.equal(analysis.steps.length, record.result.steps.length);
  for (const step of analysis.steps) {
    assert(step.durationNs > 0);
    assert(step.scheduledCpuNs >= 0);
    assert(step.durationNs / 1e6 >= record.result.steps[step.index - 1].durationMs - 250, 'Trace interval unexpectedly shorter than host step');
  }
  assert.match(await readFile(join(output, 'report.md'), 'utf8'), /Flow steps/);
  records.push({ scenario: record.scenario, trace, output, steps: analysis.steps });
}
const trace = records[0].trace;
const original = JSON.parse(await readFile(join(dirname(trace), 'step-markers.json'), 'utf8'));
for (const mode of ['missing', 'reordered', 'wrong-run']) {
  const directory = join(root, mode);
  await mkdir(directory);
  const copied = join(directory, basename(trace));
  await copyFile(trace, copied);
  const manifest = structuredClone(original);
  if (mode === 'missing') manifest.markers.pop();
  if (mode === 'reordered') manifest.markers.reverse();
  if (mode === 'wrong-run') manifest.token = '00000000-0000-0000-0000-000000000000';
  await writeFile(join(directory, 'step-markers.json'), JSON.stringify(manifest));
  const output = join(directory, 'analysis');
  assert.equal(analyze(copied, output).status, 1);
  const failure = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8'));
  assert.equal(failure.status, 'failed');
  await assert.rejects(access(join(output, 'metrics.json')));
  records.push({ mode, error: failure.error });
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', records }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
