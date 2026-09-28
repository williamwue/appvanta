import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const serial = process.argv[2];
assert(serial, 'Specify device serial');
const root = resolve('.appvanta/runs', `performance-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const cli = (...args) => spawnSync(process.execPath, ['packages/cli/dist/index.js', ...args], { encoding: 'utf8', timeout: 90000 });
const capture = cli('performance', serial, 'net.gsantner.markor', 'markor-current-state');
assert.equal(capture.status, 0, capture.stderr);
const result = JSON.parse(capture.stdout);
const measurement = JSON.parse(await readFile(result.metricsPath, 'utf8'));
const summary = JSON.parse(await readFile(result.summaryPath, 'utf8'));
assert.equal(createHash('sha256').update(await readFile(result.path)).digest('hex'), summary.rawSha256);
assert(measurement.metrics['memory.pss'].value > 0);
const baseline = { ...measurement, kind: 'baseline', metrics: Object.fromEntries(Object.entries(measurement.metrics).map(([name, metric]) => [name, { unit: metric.unit, max: metric.value }])) };
const baselinePath = join(root, 'baseline.json');
await writeFile(baselinePath, JSON.stringify(baseline, null, 2));
const passed = cli('baseline', baselinePath, result.metricsPath);
assert.equal(passed.status, 0, passed.stderr);
baseline.metrics['memory.pss'].max = 0;
const failurePath = join(root, 'deliberate-failure.json');
await writeFile(failurePath, JSON.stringify(baseline, null, 2));
const failed = cli('baseline', failurePath, result.metricsPath);
assert.equal(failed.status, 1);
assert(JSON.parse(failed.stdout).violations.some(message => message.startsWith('memory.pss:')));
const missing = cli('performance', serial, 'appvanta.nonexistent.app');
assert.equal(missing.status, 1);
assert.match(missing.stderr, /Performance parsing failed/);
const rpcInput = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'performance-verifier', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'collect_performance', arguments: { deviceId: serial, packageName: 'net.gsantner.markor', scenario: 'markor-current-state' } } },
].map(item => JSON.stringify(item)).join('\n') + '\n';
const mcp = spawnSync(process.execPath, ['packages/mcp/dist/index.js'], { input: rpcInput, encoding: 'utf8', timeout: 90000 });
assert.equal(mcp.status, 0, mcp.stderr);
const response = mcp.stdout.trim().split('\n').map(line => JSON.parse(line)).find(item => item.id === 2);
assert(!response.error, JSON.stringify(response));
const mcpCapture = JSON.parse(response.result.content[0].text);
const mcpMeasurement = JSON.parse(await readFile(mcpCapture.metricsPath, 'utf8'));
assert.deepEqual(mcpMeasurement.context, measurement.context);
assert.deepEqual(Object.keys(mcpMeasurement.metrics), Object.keys(measurement.metrics));
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', result, mcpCapture, measurement, baselinePassed: JSON.parse(passed.stdout), intentionalFailure: JSON.parse(failed.stdout), missingAppRejected: true }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
