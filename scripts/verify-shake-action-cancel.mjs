import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectDeviceLock } from '../packages/core/dist/index.js';
import { readEmulatorAcceleration } from '../packages/android/dist/emulator-sensors.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const device = process.argv[2]; assert(/^emulator-\d+$/.test(device));
assert.equal(await inspectDeviceLock(device), null);
const root = resolve('.appvanta/runs', `shake-action-cancel-${Date.now()}`);
await mkdir(root, { recursive: true });
const original = await readEmulatorAcceleration('adb', device);
const close = value => value.every((item, index) => Math.abs(item - original[index]) < 0.0001);
const owner = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const exited = once(owner, 'exit'); let stderr = ''; owner.stderr.on('data', bytes => { stderr += bytes; });
const send = message => owner.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
let runDirectory, during;
try {
  const initialized = readMcpResponses(owner.stdout, [1], 10000);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shake-cancel-verifier', version: '1' } } });
  assert((await initialized)[0].result);
  send({ method: 'notifications/initialized' });
  // Keep a reader attached throughout the cancelled call to detect an erroneous result.
  const responses = readMcpResponses(owner.stdout, [3], 60000);
  // Handle rejection immediately while device polling is in progress.
  const settled = responses.then(messages => ({ messages }), error => ({ error }));
  send({ id: 2, method: 'tools/call', params: { name: 'execute_action', arguments: { deviceId: device, action: { kind: 'shake', axis: 'z', amplitude: 12, cycles: 20, intervalMs: 1000 } } } });
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await inspectDeviceLock(device);
    if (state?.lease.runDirectory) runDirectory = state.lease.runDirectory;
    during = await readEmulatorAcceleration('adb', device);
    if (!close(during)) break;
    if (owner.exitCode !== null || owner.signalCode !== null) throw new Error(`MCP exited: ${stderr}`);
    await delay(100);
  }
  assert(runDirectory && !close(during), 'Cancel only after an observed sensor update');
  send({ method: 'notifications/cancelled', params: { requestId: 2, reason: 'Verifier cancellation after sensor update' } });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await inspectDeviceLock(device) === null) break;
    await delay(100);
  }
  assert.equal(await inspectDeviceLock(device), null, 'Cancellation must release lease after verified cleanup');
  assert(close(await readEmulatorAcceleration('adb', device)));
  const run = JSON.parse(await readFile(join(runDirectory, 'run.json'), 'utf8'));
  assert.equal(run.status, 'cancelled');
  const steps = (await readFile(join(runDirectory, 'steps.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(steps[0].status, 'cancelled');
  assert(!steps.some(step => step.description === 'Restore action state'));
  send({ id: 3, method: 'ping' });
  const result = await settled;
  if (result.error) throw result.error;
  assert(!result.messages.some(message => message.id === 2), 'Cancelled call must not emit a result');
  assert.deepEqual(result.messages.find(message => message.id === 3).result, {});
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, original, during, runDirectory, runStatus: run.status, leaseReleased: true, cancelledResponseSuppressed: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), stderr, runDirectory, lease: await inspectDeviceLock(device) }, null, 2));
  throw error;
} finally {
  if (owner.exitCode === null && owner.signalCode === null) { owner.kill(); await exited; }
}
