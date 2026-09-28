import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const serial = process.argv[2];
const recoveryMode = process.argv.includes('--recovery');
const networkCancellationOnly = process.argv.includes('--network-cancel-only');
assert(serial, 'Usage: node scripts/verify-flow.mjs <device>');
const root = resolve('.appvanta/runs', `flow-integration-${Date.now()}`);
await mkdir(root, { recursive: true });
const success = { version: 1, name: 'Markor checkpoint', steps: [{ description: 'Launch Markor', launchPackage: 'net.gsantner.markor', assertTarget: { kind: 'resource-id', value: 'net.gsantner.markor:id/nav_quicknote' } }] };
if (recoveryMode) {
  success.name = 'Recover from wrong foreground application';
  success.steps[0].launchPackage = 'com.android.settings';
  success.steps[0].timeoutMs = 1;
  success.steps[0].recovery = { maxAttempts: 1, rules: [{ description: 'Return to Markor when Settings is visible', when: { kind: 'text-visible', text: 'Settings' }, launchPackage: 'net.gsantner.markor' }] };
}
const failure = { ...success, name: 'Deliberate missing checkpoint', steps: [{ ...success.steps[0], assertTarget: { kind: 'resource-id', value: 'net.gsantner.markor:id/appvanta_missing' }, timeoutMs: 1 }] };
const exec = promisify(execFile);
const records = [];
async function verifyResult(label, result, expected) {
  assert.equal(result.status, expected, JSON.stringify(result));
  const run = JSON.parse(await readFile(join(result.runDirectory, 'run.json')));
  const report = JSON.parse(await readFile(join(result.runDirectory, 'report.json')));
  const flow = JSON.parse(await readFile(join(result.runDirectory, 'flow.json')));
  assert.equal(run.status, expected); assert.equal(report.metadata.status, expected); assert.equal(flow.version, 1);
  assert.equal(result.steps.length, 1);
  assert(result.steps[0].evidence.length > 0 || expected === 'cancelled');
  for (const path of result.steps[0].evidence) assert((await readFile(join(result.runDirectory, path))).length > 0);
  if (recoveryMode && expected !== 'cancelled') {
    const events = (await readFile(join(result.runDirectory, 'recovery.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.phase === 'selected').length, 1);
    assert.equal(events.at(-1).phase, expected);
    if (expected === 'passed') assert.match(result.steps[0].message, /recovered/);
  }
  records.push({ label, status: expected, runDirectory: result.runDirectory });
}
for (const [flow, expected] of networkCancellationOnly ? [] : [[success, 'passed'], [failure, 'failed']]) {
  const file = join(root, `${expected}.json`);
  await writeFile(file, JSON.stringify(flow));
  let stdout, code = 0;
  try { ({ stdout } = await exec(process.execPath, ['packages/cli/dist/index.js', 'run-flow', serial, file], { timeout: 90000 })); }
  catch (error) { code = error.code; stdout = error.stdout; }
  assert.equal(code, expected === 'passed' ? 0 : 1);
  await verifyResult(`CLI ${expected}`, JSON.parse(stdout), expected);
}
const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let id = 0;
let activeTask;
lines.on('line', line => {
  const value = JSON.parse(line); const entry = pending.get(value.id);
  if (!entry) return;
  pending.delete(value.id); clearTimeout(entry.timer);
  if (value.error) entry.reject(new Error(JSON.stringify(value.error))); else entry.resolve(value.result);
});
function rpc(method, params) {
  return new Promise((resolveResult, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP timeout: ${method}`)); }, 90000);
    pending.set(requestId, { resolve: resolveResult, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
}
async function tool(name, args) { const result = await rpc('tools/call', { name, arguments: args }); return JSON.parse(result.content[0].text); }
async function terminal(taskId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const task = await tool('get_task', { taskId });
    if (['passed', 'failed', 'cancelled'].includes(task.status)) return task;
    await delay(200);
  }
  throw new Error('Async task did not finish');
}
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'appvanta-verifier', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  for (const [flow, expected] of networkCancellationOnly ? [] : [[success, 'passed'], [failure, 'failed']]) {
    await verifyResult(`MCP sync ${expected}`, await tool('run_flow', { deviceId: serial, flow }), expected);
  }
  let started;
  if (recoveryMode) {
    const startedSuccess = await tool('start_flow', { deviceId: serial, flow: success });
    const finished = await terminal(startedSuccess.taskId);
    assert.equal(finished.status, 'passed');
    await verifyResult('MCP async recovery passed', finished.result, 'passed');
  }
  if (!networkCancellationOnly) {
    started = await tool('start_flow', { deviceId: serial, flow: failure });
    const failed = await terminal(started.taskId);
    assert.equal(failed.status, 'failed');
    await verifyResult('MCP async assertion', failed.result, 'failed');
  }
  const waiting = { version: 1, name: 'Cancel real wait', steps: [{ description: 'Wait for nonexistent process', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'net.appvanta.never' }, timeoutMs: 60000 } }] };
  let originalProxy;
  if (networkCancellationOnly) {
    originalProxy = (await exec('adb', ['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy'])).stdout.trim();
    waiting.network = { python: resolve('.appvanta/proxy-venv/Scripts/python.exe'), mitmdump: resolve('.appvanta/proxy-venv/Scripts/mitmdump.exe') };
  }
  const running = await tool('start_flow', { deviceId: serial, flow: waiting });
  activeTask = running.taskId;
  if (networkCancellationOnly) {
    const deadline = Date.now() + 30000;
    let changed = false;
    while (Date.now() < deadline) {
      const proxy = (await exec('adb', ['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy'])).stdout.trim();
      if (proxy === '10.0.2.2:18080') { changed = true; break; }
      await delay(200);
    }
    assert(changed, 'Network session never configured the device proxy');
  }
  await delay(4000);
  const before = await tool('get_task', { taskId: running.taskId });
  assert.equal(before.status, 'running');
  const startedCancel = Date.now();
  await tool('cancel_task', { taskId: running.taskId });
  const cancelled = await terminal(running.taskId);
  assert.equal(cancelled.status, 'cancelled'); assert(Date.now() - startedCancel < 10000);
  await verifyResult('MCP async cancellation', cancelled.result, 'cancelled');
  if (networkCancellationOnly) {
    assert.equal((await exec('adb', ['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy'])).stdout.trim(), originalProxy);
    const summary = JSON.parse(await readFile(join(cancelled.result.runDirectory, 'network/summary.json')));
    assert.equal(summary.proxyRestored, true);
    records.at(-1).proxyRestored = true;
  }
  if (started) {
    const terminalCancel = await tool('cancel_task', { taskId: started.taskId });
    assert.equal(terminalCancel.status, 'failed', 'Cancelling terminal task must not rewrite history');
  }
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', records }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, records }));
} finally {
  if (activeTask && child.exitCode === null) {
    await tool('cancel_task', { taskId: activeTask });
    await terminal(activeTask);
  }
  for (const entry of pending.values()) clearTimeout(entry.timer);
  lines.close(); child.kill();
}
