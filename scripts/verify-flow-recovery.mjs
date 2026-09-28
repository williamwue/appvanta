import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectDeviceLock } from '../packages/core/dist/device-lock.js';
import { parseAppOpMode } from '../packages/android/dist/appops-fixture.js';
const device = process.argv[2]; assert(device, 'Specify device');
const id = Date.now(), root = resolve('.appvanta/runs', `flow-recovery-check-${id}`);
await mkdir(root, { recursive: true });
const target = `/storage/emulated/0/Download/appvanta-flow-recovery-${id}.txt`;
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ime = () => ({ selected: adb('shell', 'settings', 'get', 'secure', 'default_input_method'), enabled: adb('shell', 'ime', 'list', '-s').split(/\r?\n/).filter(Boolean).sort() });
const operation = 'MANAGE_EXTERNAL_STORAGE', pkg = 'net.gsantner.markor';
const appop = () => parseAppOpMode(adb('shell', 'cmd', 'appops', 'get', pkg, operation), operation);
const before = { ime: ime(), appop: appop() };
const flow = { version: 1, name: 'Combined interrupted fixtures', files: [{ path: target, content: 'prepared' }], inputMethod: 'dev.appvanta.input/.InputService', appOps: [{ packageName: pkg, operation, mode: before.appop === 'ignore' ? 'allow' : 'ignore' }], steps: [{ description: 'Wait for interruption', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'appvanta.never' }, timeoutMs: 60000 } }] };
const module = pathToFileURL(resolve('packages/android/dist/flow.js')).href;
const child = spawn(process.execPath, ['--input-type=module', '-e', `import {runAndroidFlow} from ${JSON.stringify(module)}; await runAndroidFlow(${JSON.stringify(device)}, ${JSON.stringify(flow)});`], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
const exited = once(child, 'exit');
const mcp = process.argv.includes('--mcp');
const callMcp = (name, args) => {
  const requests = [
    { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'recovery-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } },
  ];
  const result = spawnSync(process.execPath, ['packages/mcp/dist/index.js'], { input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const reply = result.stdout.trim().split('\n').map(JSON.parse).find(item => item.id === 'call');
  if (reply.error) throw new Error(reply.error.message);
  const text = reply.result.content[0].text;
  if (reply.result.isError) throw new Error(text);
  return text;
};
const cli = token => mcp ? callMcp('recover_flow', { deviceId: device, leaseToken: token }) : execFileSync(process.execPath, ['packages/cli/dist/index.js', 'recover-flow', device, token], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  let lease;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await inspectDeviceLock(device);
    if (state?.lease.runDirectory) {
      try {
        if ((await readFile(join(state.lease.runDirectory, 'actions.jsonl'), 'utf8')).includes('started')) { lease = state.lease; break; }
      } catch {}
    }
    if (child.exitCode !== null) throw new Error('Flow exited before interruption');
    await new Promise(done => setTimeout(done, 100));
  }
  assert(lease, 'Flow did not enter action');
  if (mcp) {
    const observed = JSON.parse(callMcp('inspect_device_lock', { deviceId: device }));
    assert.equal(observed.owner, 'alive');
    assert.equal(observed.lease.token, lease.token);
  }
  assert.throws(() => cli(lease.token), /alive/);
  child.kill('SIGKILL'); await exited;
  const actions = await readFile(join(lease.runDirectory, 'actions.jsonl'), 'utf8');
  const external = join(root, 'external.txt'); await writeFile(external, 'external'); adb('push', external, target);
  assert.throws(() => cli(lease.token), /incomplete/);
  assert.equal((await inspectDeviceLock(device)).lease.token, lease.token);
  assert.equal(adb('shell', 'cat', target), 'external');
  assert.deepEqual(ime(), before.ime); assert.equal(appop(), before.appop);
  adb('push', join(lease.runDirectory, 'fixtures/0.prepared.txt'), target);
  const result = JSON.parse(cli(lease.token));
  assert.equal(result.status, 'recovered'); assert.equal(result.steps.length, 3);
  assert.equal(await inspectDeviceLock(device), null);
  assert.equal(adb('shell', `test ! -e '${target}' && echo absent`), 'absent');
  assert.deepEqual(ime(), before.ime); assert.equal(appop(), before.appop);
  assert.equal(await readFile(join(lease.runDirectory, 'actions.jsonl'), 'utf8'), actions);
  assert.notEqual(JSON.parse(await readFile(join(lease.runDirectory, 'run.json'), 'utf8')).status, 'passed');
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', transport: mcp ? 'mcp' : 'cli', before, result, lease }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
