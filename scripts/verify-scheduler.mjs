import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withDeviceLock } from '../packages/core/dist/index.js';

const devices = process.argv.slice(2);
assert(devices.length >= 1 && new Set(devices).size === devices.length, 'Supply unique online device serials');
const root = resolve('.appvanta/runs', `scheduler-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const flowPath = join(root, 'flow.json');
await writeFile(flowPath, JSON.stringify({ version: 1, name: 'Multi-device Settings', steps: [
  { description: 'Launch Settings', launchPackage: 'com.android.settings' },
  { description: 'Verify Settings process and title', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'com.android.settings' }, timeoutMs: 5000 }, assertText: 'Settings' },
] }));
const exec = promisify(execFile);
async function mcp(name, args) {
  const input = [{ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verifier', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }].map(JSON.stringify).join('\n') + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n';
  const output = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true });
    let data = ''; child.stdout.on('data', bytes => { data += bytes; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('MCP verification timed out')); }, 120000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); code === 0 ? done(data) : reject(new Error(`MCP exited ${code}`)); });
    child.stdin.end(input);
  });
  return output.trim().split('\n').map(JSON.parse).find(item => item.id === 1);
}
async function cli(...args) {
  try { const result = await exec(process.execPath, ['packages/cli/dist/index.js', ...args], { timeout: 120000 }); return { ...result, code: 0 }; }
  catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}
const batches = [];
for (const ids of [devices, [...devices, 'appvanta-offline-fixture']]) {
  const result = await cli('run-flows', ids.join(','), flowPath, '2');
  await writeFile(join(root, `attempt-${batches.length + 1}.json`), JSON.stringify(result, null, 2));
  const expected = ids.length === devices.length ? 'passed' : 'failed';
  assert.equal(result.code, expected === 'passed' ? 0 : 1, result.stderr || result.stdout);
  const batch = JSON.parse(result.stdout);
  assert.equal(batch.status, expected, result.stdout);
  const summary = JSON.parse(await readFile(join(batch.runDirectory, 'summary.json')));
  assert.equal(summary.results.length, ids.length);
  const paths = new Set();
  for (const device of summary.results) {
    if (device.deviceId === 'appvanta-offline-fixture') { assert.equal(device.status, 'failed'); assert.match(device.error, /offline/); continue; }
    assert.equal(device.status, 'passed');
    paths.add(device.value.runDirectory);
    const report = JSON.parse(await readFile(join(device.value.runDirectory, 'report.json')));
    assert.equal(report.steps.length, 2);
    assert.equal(report.metadata.status, 'passed');
  }
  assert.equal(paths.size, devices.length, 'Device evidence directories overlap');
  batches.push({ status: expected, runDirectory: batch.runDirectory });
}
assert.equal((await cli('run-flows', `${devices[0]},${devices[0]}`, flowPath)).code, 1);
const multi = await mcp('run_flows', { deviceIds: devices, flow: JSON.parse(await readFile(flowPath)), concurrency: 2 });
assert(!multi.error, JSON.stringify(multi));
const multiResult = JSON.parse(multi.result.content[0].text);
assert.equal(multiResult.status, 'passed'); assert.equal(multiResult.results.length, devices.length);
batches.push({ interface: 'MCP', status: multiResult.status, runDirectory: multiResult.runDirectory });
await withDeviceLock(devices[0], async () => {
  const conflict = await cli('launch', devices[0], 'net.gsantner.markor');
  assert.equal(conflict.code, 1); assert.match(conflict.stderr, /Device busy/);
  const output = await mcp('start_app', { deviceId: devices[0], packageName: 'net.gsantner.markor' });
  assert.equal(output.result.isError, true);
  assert.match(JSON.parse(output.result.content[0].text).error, /Device busy/);
});
assert.equal((await cli('launch', devices[0], 'net.gsantner.markor')).code, 0, 'Lease was not released');
const verification = { status: 'passed', devices, batches, cliAndMcpLeaseConflict: true, duplicateRejected: true };
await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
console.log(JSON.stringify({ ...verification, root }));
