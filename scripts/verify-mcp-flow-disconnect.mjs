import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectDeviceLock } from '../packages/core/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deviceId = process.argv[2];
if (!deviceId) throw new Error('Usage: node scripts/verify-mcp-flow-disconnect.mjs <device-id>');
assert.equal(await inspectDeviceLock(deviceId), null, 'Device already leased');
const directory = join(root, '.appvanta/runs', `mcp-flow-disconnect-${Date.now()}`);
await mkdir(directory, { recursive: true });
const report = { status: 'running', deviceId, directory };
const child = spawn(process.execPath, [join(root, 'packages/mcp/dist/index.js')], {
  cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, APPVANTA_PROJECT_ROOT: root },
});
let stdout = '', stderr = '', spawnError;
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
child.on('error', error => { spawnError = error; });
const exited = () => child.exitCode !== null || child.signalCode !== null;
const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const wait = async (predicate, timeout, label) => {
  const deadline = Date.now() + timeout;
  do {
    if (spawnError) throw spawnError;
    const value = await predicate();
    if (value) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const actions = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
try {
  const response = readMcpResponses(child.stdout, [1]);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'flow-eof-verifier', version: '1' } } });
  assert((await response)[0].result);
  send({ method: 'notifications/initialized' });
  const action = { kind: 'wait', condition: { kind: 'app-running', packageName: `dev.appvanta.absent.p${Date.now()}` }, timeoutMs: 60000 };
  send({ id: 2, method: 'tools/call', params: { name: 'run_flow', arguments: { deviceId, flow: { version: 1, name: 'MCP EOF verification', steps: [{ description: 'Wait for absent application', action }] } } } });
  const lease = await wait(async () => {
    assert(!exited(), `MCP exited before action: ${stderr}`);
    const state = await inspectDeviceLock(deviceId);
    if (!state?.lease.runDirectory) return;
    assert.equal(state.owner, 'alive');
    assert.equal(state.lease.pid, child.pid);
    try {
      const journal = await actions(join(state.lease.runDirectory, 'actions.jsonl'));
      if (!journal.length) return;
      assert.equal(journal.length, 1, 'Wait completed before disconnect');
      assert.equal(journal[0].phase, 'started');
      assert.deepEqual(journal[0].operation.action, action);
      return state;
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
  }, 45000, 'bound lease and dispatched wait action');
  report.beforeDisconnect = lease;
  const started = Date.now();
  child.stdin.end();
  await wait(exited, 10000, 'MCP graceful EOF exit');
  report.elapsedMs = Date.now() - started;
  report.exitCode = child.exitCode;
  report.signal = child.signalCode;
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  const runDirectory = lease.lease.runDirectory;
  report.run = await json(join(runDirectory, 'run.json'));
  report.progress = await json(join(runDirectory, 'progress.json'));
  const result = await json(join(runDirectory, 'report.json'));
  report.actions = await actions(join(runDirectory, 'actions.jsonl'));
  report.leaseAfter = await inspectDeviceLock(deviceId);
  assert.equal(report.run.status, 'cancelled');
  assert.equal(report.progress.phase, 'finished');
  assert.equal(report.progress.status, 'cancelled');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].status, 'cancelled');
  assert.equal(report.actions.length, 2);
  assert.equal(report.actions[1].phase, 'finished');
  assert.equal(report.actions[1].status, 'failed');
  assert.equal(report.leaseAfter, null);
  assert(!stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).some(message => message.id === 2), 'Cancelled request returned a response');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  throw error;
} finally {
  if (!exited()) {
    report.fallbackCleanup = true;
    child.stdin.end();
    try { await wait(exited, 10000, 'failure cleanup'); }
    catch {
      child.kill();
      try { await wait(exited, 5000, 'owned server termination'); }
      catch (error) { report.cleanupError = String(error); }
    }
  }
  await writeFile(join(directory, 'stdout.log'), stdout);
  await writeFile(join(directory, 'stderr.log'), stderr);
  await writeFile(join(directory, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, directory, elapsedMs: report.elapsedMs }));
}
