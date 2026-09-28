import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const [traceArg, pythonArg] = process.argv.slice(2);
assert(traceArg && pythonArg, 'Specify retained Android trace and Perfetto Python executable');
const trace = resolve(traceArg), python = resolve(pythonArg);
const root = resolve('.appvanta/runs', `perfetto-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const run = (exe, args, input) => spawnSync(exe, args, { input, encoding: 'utf8', timeout: 120000 });
const cli = (...args) => run(process.execPath, ['packages/cli/dist/index.js', ...args]);
const capture = cli('analyze-perfetto', trace, 'net.gsantner.markor', python, '20000');
assert.equal(capture.status, 0, capture.stderr);
const result = JSON.parse(capture.stdout);
const measurement = JSON.parse(await readFile(result.metricsPath, 'utf8'));
const analysis = JSON.parse(await readFile(join(result.output, 'analysis.json'), 'utf8'));
assert.equal(analysis.traceSha256, createHash('sha256').update(await readFile(trace)).digest('hex'));
assert.equal(analysis.window.durationMs, 20000);
assert(measurement.metrics['cpu.scheduledTime'].value > 0);
assert.equal(analysis.threads.reduce((sum, row) => sum + row.scheduled_ns, 0), measurement.metrics['cpu.scheduledTime'].value);
assert.match(await readFile(result.report, 'utf8'), /Scheduled CPU time/);
const messages = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'perfetto-verifier', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'analyze_perfetto', arguments: { trace, packageName: 'net.gsantner.markor', python, windowMs: 20000 } } },
];
const rpc = run(process.execPath, ['packages/mcp/dist/index.js'], messages.map(JSON.stringify).join('\n') + '\n');
assert.equal(rpc.status, 0, rpc.stderr);
const response = rpc.stdout.trim().split('\n').map(JSON.parse).find(item => item.id === 2);
assert(!response.error && !response.result.isError, JSON.stringify(response));
const mcp = JSON.parse(response.result.content[0].text);
assert.deepEqual(JSON.parse(await readFile(mcp.metricsPath, 'utf8')), measurement);
const baseline = { ...measurement, kind: 'baseline', metrics: Object.fromEntries(Object.entries(measurement.metrics).map(([name, metric]) => [name, { unit: metric.unit, max: metric.value }])) };
const baselinePath = join(root, 'baseline.json');
await writeFile(baselinePath, JSON.stringify(baseline));
assert.equal(cli('baseline', baselinePath, result.metricsPath).status, 0);
baseline.metrics['cpu.scheduledTime'].max = 0;
await writeFile(join(root, 'failing-baseline.json'), JSON.stringify(baseline));
assert.equal(cli('baseline', join(root, 'failing-baseline.json'), result.metricsPath).status, 1);
const malformed = join(root, 'invalid.trace');
await writeFile(malformed, 'not a trace');
const failures = [];
for (const [name, source, app, window, expected] of [
  ['missing-app', trace, 'appvanta.nonexistent.app', '20000', /absent from trace/],
  ['short-trace', trace, 'net.gsantner.markor', '999999', /does not cover/],
  ['malformed', malformed, 'net.gsantner.markor', '20000', /./],
]) {
  const output = join(root, name);
  const failure = run(python, ['scripts/analyze-perfetto.py', '--trace', source, '--package', app, '--output', output, '--window-ms', window]);
  assert.equal(failure.status, 1, failure.stderr);
  const evidence = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8'));
  assert.equal(evidence.status, 'failed');
  assert.match(evidence.error, expected);
  await assert.rejects(access(join(output, 'metrics.json')));
  failures.push({ name, error: evidence.error });
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', result, mcp, measurement, failures, baselinePassAndFail: true }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
