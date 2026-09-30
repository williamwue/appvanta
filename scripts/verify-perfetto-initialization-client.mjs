import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { analyzePerfetto } from '../packages/android/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const [root, python, client] = process.argv.slice(2);
assert(root && python && ['sdk', 'mcp'].includes(client));
const options = { trace: join(root, 'input.trace'), packageName: 'dev.appvanta.fixture', python };
const controller = new AbortController(), before = new Set(await readdir('.appvanta/runs'));
let child, exited, pending, finished = false, rpcOutput = '';
const send = value => child.stdin.write(JSON.stringify(value) + '\n');
const stopped = async pid => {
  if (process.platform === 'linux') {
    try { if ((await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].startsWith('Z ')) return true; } catch {}
  }
  try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; }
};
const cancel = () => {
  if (client === 'sdk') controller.abort(new Error('Cancel SDK during actual tool download'));
  else if (child && child.exitCode === null && child.signalCode === null) send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'Cancel during actual tool download' } });
};
try {
  if (client === 'sdk') {
    pending = analyzePerfetto({ ...options, signal: controller.signal }).then(value => ({ value }), error => ({ error: String(error) })).finally(() => { finished = true; });
  } else {
    child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    exited = once(child, 'exit'); child.stderr.resume(); child.stdout.on('data', data => { rpcOutput += data; });
    const initialized = readMcpResponses(child.stdout, [1]);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'download-cancel-verifier', version: '1' } } });
    await initialized;
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'analyze_perfetto', arguments: options } });
  }
  let entered = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !finished) {
    try { await access(join(root, 'http-entered')); entered = true; break; } catch {}
    await delay(10);
  }
  cancel();
  assert(entered, 'Downloader did not reach HTTP checkpoint');
  const names = (await readdir('.appvanta/runs', { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith('perfetto-analysis-') && !before.has(entry.name)).map(entry => entry.name);
  assert.equal(names.length, 1, 'Expected exactly one owned analysis');
  const output = resolve('.appvanta/runs', names[0]);
  if (pending) assert.match((await pending).error, /cancellation requested/);
  let summary, initialization;
  const cleanupDeadline = Date.now() + 15000;
  while (Date.now() < cleanupDeadline) {
    try {
      summary = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8'));
      initialization = JSON.parse(await readFile(join(output, 'initialization.json'), 'utf8'));
      if (await stopped(initialization.analysisPid)) break;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(10);
  }
  assert.equal(summary?.status, 'cancelled');
  assert.equal(summary.cancellation.resolverExited, true);
  assert.equal(summary.cancellation.processorPid, null);
  assert.equal(summary.cancellation.cleanupError, null);
  for (const name of ['metrics.json', 'report.md', 'processor.json']) await assert.rejects(access(join(output, name)));
  const download = JSON.parse(await readFile(join(root, 'child.json'), 'utf8'));
  for (const pid of [initialization.analysisPid, initialization.pid, download.pid]) assert(await stopped(pid), `Owned process ${pid} remains alive`);
  if (client === 'mcp') {
    const listed = readMcpResponses(child.stdout, [3]);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert((await listed)[0].result.tools.length > 0);
    assert(!rpcOutput.trim().split('\n').map(JSON.parse).some(message => message.id === 2));
  }
  console.log(JSON.stringify({ status: 'passed', client, output, initialization, cancellation: summary.cancellation,
    downloadPid: download.pid, ...(client === 'mcp' ? { cancelledResponseSuppressed: true, toolsListAfterCancel: true } : {}) }));
} finally {
  cancel();
  if (pending) await pending;
  if (child) { child.kill(); await exited; }
}
