import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectDeviceLock } from '../packages/core/dist/index.js';
import { readEmulatorAcceleration } from '../packages/android/dist/emulator-sensors.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const device = process.argv[2]; assert(/^emulator-\d+$/.test(device), 'Emulator serial required');
assert.equal(await inspectDeviceLock(device), null, 'Verifier requires an available device');
const root = resolve('.appvanta/runs', `shake-flow-${Date.now()}`);
await mkdir(root, { recursive: true });
const original = await readEmulatorAcceleration('adb', device);
const close = value => value.every((item, index) => Math.abs(item - original[index]) < 0.0001);
const action = { kind: 'shake', axis: 'x', amplitude: 12, cycles: 2, intervalMs: 150 };
const flow = { name: 'Managed emulator shake', steps: [{ description: 'Shake and restore', action }] };
const flowPath = join(root, 'flow.json'); await writeFile(flowPath, JSON.stringify(flow));
const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', ...args], { timeout: 120000, windowsHide: true })).stdout);
const run = await cli('run-flow', device, flowPath);
assert.equal(run.status, 'passed'); assert.equal(run.cleanupFailed, false);
assert(close(await readEmulatorAcceleration('adb', device)));
const records = await readdir(join(run.runDirectory, 'fixtures/emulator-sensors'));
assert.equal(records.filter(name => name.endsWith('.restored.json')).length, 1);
console.log('CLI shake passed');
const mcpProcess = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let mcp;
const directActions = [];
try {
  const responses = readMcpResponses(mcpProcess.stdout, [1, 2, 3], 120000);
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shake-flow-verifier', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_flow', arguments: { deviceId: device, flow } } },
  ]) mcpProcess.stdin.write(JSON.stringify(message) + '\n');
  const messages = await responses;
  const tool = messages.find(message => message.id === 2).result.tools.find(tool => tool.name === 'run_flow');
  assert(tool.inputSchema.$defs.action.oneOf.some(schema => schema.properties.kind.const === 'shake'));
  const response = messages.find(message => message.id === 3).result;
  assert.notEqual(response.isError, true, JSON.stringify(response));
  mcp = JSON.parse(response.content[0].text);
  assert.equal(mcp.status, 'passed'); assert.equal(mcp.cleanupFailed, false);
  assert(close(await readEmulatorAcceleration('adb', device)));
  for (const [offset, axis] of ['y', 'z'].entries()) {
    const id = 4 + offset, requested = { ...action, axis };
    const directResponses = readMcpResponses(mcpProcess.stdout, [id], 120000);
    mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'execute_action', arguments: { deviceId: device, action: requested } } }) + '\n');
    const response = (await directResponses).find(message => message.id === id).result;
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.success, true); assert.equal(result.status, 'passed'); assert.equal(result.cleanupFailed, false);
    assert(Number.isFinite(Date.parse(result.startedAt)) && Number.isFinite(Date.parse(result.finishedAt)));
    const saved = JSON.parse(await readFile(join(result.runDirectory, 'flow.json'), 'utf8'));
    assert.deepEqual(saved.steps[0].action, requested);
    const directory = join(result.runDirectory, 'fixtures/emulator-sensors');
    const sources = (await readdir(directory)).filter(name => !name.endsWith('.restored.json'));
    assert.equal(sources.length, 1);
    const record = JSON.parse(await readFile(join(directory, sources[0]), 'utf8'));
    assert.equal(record.options.axis, axis);
    assert(close(await readEmulatorAcceleration('adb', device)));
    assert.equal(await inspectDeviceLock(device), null);
    directActions.push(result);
  }
} finally {
  if (mcpProcess.exitCode === null && mcpProcess.signalCode === null) { const exited = once(mcpProcess, 'exit'); mcpProcess.kill(); await exited; }
}
console.log('MCP shake passed');
const interrupted = { ...flow, steps: [{ description: 'Interrupt during shake', action: { ...action, cycles: 20, intervalMs: 1000 } }] };
const code = `import {runAndroidFlow} from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};await runAndroidFlow(${JSON.stringify(device)},${JSON.stringify(interrupted)},undefined,async root=>{process.send({root});});`;
const owner = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const exited = once(owner, 'exit'); let stderr = ''; owner.stderr.on('data', bytes => { stderr += bytes; });
let recovery, interruptedRun, during, conflictRefusal;
try {
  const [message] = await Promise.race([once(owner, 'message', { signal: AbortSignal.timeout(30000) }), exited.then(() => { throw new Error(stderr); })]);
  interruptedRun = message.root;
  for (let attempt = 0; attempt < 200; attempt++) {
    during = await readEmulatorAcceleration('adb', device);
    if (!close(during)) break;
    if (owner.exitCode !== null || owner.signalCode !== null) throw new Error(`Owner exited before mutation: ${stderr}`);
    await delay(100);
  }
  assert(!close(during), 'Must observe a sensor mutation before killing owner');
  owner.kill('SIGKILL'); await exited;
  const lease = await inspectDeviceLock(device);
  assert.equal(lease.owner, 'dead'); assert.equal(lease.lease.pid, owner.pid);
  assert.equal(lease.lease.runDirectory, interruptedRun);
  const names = await readdir(join(interruptedRun, 'fixtures/emulator-sensors'));
  assert.equal(names.filter(name => name.endsWith('.restored.json')).length, 0);
  const conflict = [...original]; conflict[0] += 3;
  const setSensor = async value => {
    const result = await promisify(execFile)('adb', ['-s', device, 'emu', 'sensor', 'set', 'acceleration', value.join(':')], { timeout: 10000, windowsHide: true });
    assert.equal(result.stdout.trim(), 'OK');
  };
  await setSensor(conflict);
  await assert.rejects(cli('recover-flow', device, lease.lease.token), error => {
    conflictRefusal = String(error);
    return /Environment recovery incomplete/.test(conflictRefusal);
  });
  assert.deepEqual((await inspectDeviceLock(device)).lease, lease.lease, 'Conflict must retain the exact lease');
  const afterConflict = await readEmulatorAcceleration('adb', device);
  assert(afterConflict.every((value, index) => Math.abs(value - conflict[index]) < 0.0001));
  const afterNames = await readdir(join(interruptedRun, 'fixtures/emulator-sensors'));
  assert.equal(afterNames.filter(name => name.endsWith('.restored.json')).length, 0);
  // Remove only this verifier's conflict; normal recovery then owns restoration.
  await setSensor(during);
  recovery = await cli('recover-flow', device, lease.lease.token);
  assert.equal(recovery.status, 'recovered');
  assert(recovery.steps.some(step => step.fixture === 'emulator-sensors' && step.status === 'passed'));
  assert(close(await readEmulatorAcceleration('adb', device)));
  assert.equal(await inspectDeviceLock(device), null);
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), stderr, interruptedRun, lease: await inspectDeviceLock(device) }, null, 2));
  throw error;
} finally {
  if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exited; }
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, original, run, mcp, directActions, interruptedRun, during, conflictRefusal, recovery, limitations: ['Android Emulator only; physical devices and arbitrary app shake responses not covered.', 'Business actions are not resumed by recovery.'] }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
