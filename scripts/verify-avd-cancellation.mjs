import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startAndroidAvd } from '../packages/android/dist/index.js';
import { inspectDeviceLock } from '../packages/core/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const [name, serial, client = 'sdk'] = process.argv.slice(2);
assert(['sdk', 'mcp', 'cli'].includes(client), 'Client must be sdk, mcp or cli');
assert(client !== 'cli' || process.platform !== 'win32', 'CLI signal verification requires POSIX; Windows console signals need separate verification');
assert((name?.startsWith('AppVanta_') || name === 'appvanta-ci') && /^emulator-\d+$/.test(serial), 'Specify an already running AppVanta test AVD and serial');
const adb = async args => (await promisify(execFile)(process.env.ADB_PATH || 'adb', args, { encoding: 'utf8', timeout: 5000, windowsHide: true })).stdout.trim();
assert.equal((await adb(['-s', serial, 'emu', 'avd', 'name'])).split(/\r?\n/)[0].trim(), name);
assert.equal(await inspectDeviceLock(serial), null);
const bootBefore = await adb(['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']);
await mkdir('.appvanta/emulators', { recursive: true });
const before = new Set(await readdir('.appvanta/emulators'));
const controller = new AbortController();
let finished = false;
let operation, child, closed, output = '', stderr = '';
const send = message => child.stdin.write(JSON.stringify(message) + '\n');
const cancel = () => {
  if (client === 'sdk') controller.abort(new Error('Verifier cancelled reused AVD startup'));
  else if (child && child.exitCode === null && child.signalCode === null) {
    if (client === 'mcp') send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'AVD wait verification' } });
    else child.kill('SIGINT');
  }
};
let startup;
try {
  if (client === 'sdk') {
    operation = startAndroidAvd(name, Number(serial.slice(9)), 30000, undefined, controller.signal)
      .then(result => ({ result }), error => ({ error: String(error) })).finally(() => { finished = true; });
  } else {
    child = spawn(process.execPath, client === 'mcp' ? ['packages/mcp/dist/index.js'] : ['packages/cli/dist/index.js', 'start-avd', name, serial.slice(9), '30000'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    closed = once(child, 'close'); closed.catch(() => {});
    child.once('exit', () => { finished = true; });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { stderr += data; });
    if (client === 'mcp') {
      const initialized = readMcpResponses(child.stdout, [1]);
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'avd-cancel-verifier', version: '1' } } });
      await initialized;
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'start_avd', arguments: { name, port: Number(serial.slice(9)), timeoutMs: 30000 } } });
    }
  }
  const deadline = Date.now() + 15000;
  while (!startup) {
    assert(!finished, 'Startup finished before cancellation checkpoint');
    assert(Date.now() < deadline, 'Startup checkpoint timed out');
    for (const entry of (await readdir('.appvanta/emulators')).filter(item => !before.has(item))) {
      try {
        const value = JSON.parse(await readFile(join('.appvanta/emulators', entry, 'startup.json'), 'utf8'));
        if (value.name === name && value.serial === serial && value.status === 'starting') startup = value;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    if (!startup) await delay(5);
  }
  const cancelledAt = Date.now();
  cancel();
  if (operation) assert.match((await operation).error, /startup wait cancelled/);
  let record;
  while (Date.now() - cancelledAt < 5000) {
    try { record = JSON.parse(await readFile(join(startup.directory, 'startup.json'), 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (record?.status === 'cancelled' && await inspectDeviceLock(serial) === null && await inspectDeviceLock(`avd:${name}`) === null) break;
    await delay(5);
  }
  const elapsedMs = Date.now() - cancelledAt;
  assert(elapsedMs < 5000, 'Cancellation exceeded five seconds');
  assert.equal(record.status, 'cancelled'); assert.equal(record.reused, true);
  assert.equal(await inspectDeviceLock(serial), null);
  assert.equal(await inspectDeviceLock(`avd:${name}`), null);
  if (client === 'mcp') {
    const listed = readMcpResponses(child.stdout, [3]);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert((await listed).find(message => message.id === 3)?.result?.tools.length > 0);
    assert(!output.trim().split('\n').map(JSON.parse).some(message => message.id === 2), 'Cancelled MCP response must be suppressed');
  } else if (client === 'cli') {
    const [code, signal] = await closed;
    assert.equal(code, 1); assert.equal(signal, null);
    assert.match(stderr, /startup wait cancelled/);
  }
  assert.equal(await adb(['-s', serial, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']), bootBefore);
  assert.equal(await adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']), '1');
  const resumed = await startAndroidAvd(name, Number(serial.slice(9)), 30000);
  assert.equal(resumed.status, 'ready'); assert.equal(resumed.reused, true);
  const root = resolve('.appvanta/runs', `avd-cancellation-${Date.now()}`); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', scope: 'reused live AVD wait cancellation', client, record, resumed, bootBefore, elapsedMs, ...(client === 'mcp' ? { cancelledResponseSuppressed: true, toolsListAfterCancel: true } : {}), ...(client === 'cli' ? { signal: 'SIGINT', exitCode: 1 } : {}) }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, client, elapsedMs }));
} finally {
  cancel(); if (operation) await operation;
  if (child) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await closed; } finally { clearTimeout(timeout); }
  }
}
