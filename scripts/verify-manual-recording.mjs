import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AdbDriver } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), serial = process.argv[2];
assert(serial, 'Usage: node scripts/verify-manual-recording.mjs <device-id>');
const delay = ms => new Promise(done => setTimeout(done, ms)), exec = promisify(execFile);

async function mcpCall(name, args) {
  const child = spawn(process.execPath, [resolve(root, 'packages/mcp/dist/index.js')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, APPVANTA_PROJECT_ROOT: root } });
  const messages = [], errors = [], stdout = createInterface({ input: child.stdout }), stderr = createInterface({ input: child.stderr });
  stdout.on('line', line => messages.push(JSON.parse(line))); stderr.on('line', line => errors.push(line));
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  const waitFor = async id => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { const response = messages.find(value => value.id === id); if (response) return response; await delay(25); }
    throw new Error(`MCP timeout: ${errors.join('\n')}`);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'manual-recording-verifier', version: '1' } } }); assert((await waitFor(1)).result);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    const response = await waitFor(2); assert.equal(response.result?.isError, undefined, JSON.stringify(response)); return JSON.parse(response.result.content[0].text);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const deadline = Date.now() + 5000; while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
    stdout.close(); stderr.close();
  }
}

const startedAt = new Date().toISOString();
const session = await mcpCall('start_interaction_recording', { deviceId: serial, packages: ['com.android.settings'], includeText: false });
await exec('adb', ['-s', serial, 'shell', 'am', 'force-stop', 'com.android.settings'], { timeout: 20000 });
await exec('adb', ['-s', serial, 'shell', 'am', 'force-stop', 'com.google.android.settings.intelligence'], { timeout: 20000 });
await exec('adb', ['-s', serial, 'shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS'], { timeout: 20000 }); await delay(1000);
const driver = new AdbDriver({ artifactsDirectory: resolve(session.rootDirectory, 'interaction-artifacts') });
await withDeviceLock(serial, () => driver.execute(serial, { kind: 'tap', target: { kind: 'resource-id', value: 'com.android.settings:id/search_action_bar' } })); await delay(500);

const stopped = await mcpCall('stop_interaction_recording', { deviceId: serial, recordingId: session.recordingId });
assert.equal(stopped.status, 'stopped'); assert(stopped.eventCount > 0); assert(stopped.flow.steps.length > 0);
assert(stopped.flow.steps.some(step => step.action?.kind === 'tap' && step.action.target.kind === 'resource-id' && step.action.target.value === 'com.android.settings:id/search_action_bar'), JSON.stringify(stopped.flow));

await exec('adb', ['-s', serial, 'shell', 'am', 'force-stop', 'com.android.settings'], { timeout: 20000 });
await exec('adb', ['-s', serial, 'shell', 'am', 'force-stop', 'com.google.android.settings.intelligence'], { timeout: 20000 });
await exec('adb', ['-s', serial, 'shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS'], { timeout: 20000 }); await delay(1000);
const replay = await mcpCall('run_flow', { deviceId: serial, flow: stopped.flow }); assert.equal(replay.status, 'passed', JSON.stringify(replay));

const evidenceDirectory = resolve(root, '.appvanta/runs', `manual-recording-check-${Date.now()}`); await mkdir(evidenceDirectory, { recursive: false });
const events = (await readFile(stopped.eventsPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const verification = { version: 1, status: 'passed', serial, startedAt, finishedAt: new Date().toISOString(), recordingId: session.recordingId, recordingRoot: session.rootDirectory, eventCount: stopped.eventCount, ignoredCount: stopped.ignoredCount, events, flow: stopped.flow, replay: { status: replay.status, runDirectory: replay.runDirectory } };
await writeFile(join(evidenceDirectory, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: 'passed', evidenceDirectory, recordingId: session.recordingId, eventCount: stopped.eventCount, steps: stopped.flow.steps.length, replay: replay.runDirectory }));
