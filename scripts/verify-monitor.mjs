import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function client() {
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const input = createInterface({ input: child.stdout });
  const pending = new Map(); let sequence = 0;
  input.on('line', line => {
    const message = JSON.parse(line), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else if (message.result.isError) request.reject(new Error(message.result.content[0].text));
    else request.resolve(JSON.parse(message.result.content[0].text));
  });
  child.on('exit', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('MCP exited')); } pending.clear(); });
  child.stdin.write([{ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'monitor-verifier', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }].map(JSON.stringify).join('\n') + '\n');
  return {
    async close() { if (child.exitCode === null && !child.killed) { const closed = once(child, 'exit'); child.kill(); await closed; } input.close(); },
    tool(name, args) { return new Promise((resolveRequest, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${name}`)); }, 30000);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    }); },
  };
}

const serial = process.argv[2];
assert(serial, 'Usage: node scripts/verify-monitor.mjs <device>');
const owner = client(), observer = client();
let monitor;
async function waitFor(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await observer.tool('get_monitor', { monitorId: monitor.id });
    if (predicate(current)) return current;
    await delay(100);
  }
  throw new Error('Monitor state deadline exceeded');
}

try {
  monitor = await owner.tool('start_monitor', { deviceId: serial, intervalMs: 500, durationMs: 10000 });
  const sampled = await waitFor(current => current.status === 'running' && current.sampleCount >= 2);
  assert((await observer.tool('list_monitors', {})).some(current => current.id === monitor.id));
  assert.equal((await observer.tool('release_monitor', { monitorId: monitor.id })).status, 'releasing');
  const completed = await waitFor(current => ['released', 'failed'].includes(current.status));
  assert.equal(completed.status, 'released');
  assert(completed.sampleCount >= sampled.sampleCount);
  const lines = (await readFile(join(completed.rootDirectory, 'observations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, completed.sampleCount);
  for (const sample of lines) {
    for (const field of ['screenshotPath', 'uiTreePath', 'uiDescriptionPath']) {
      assert.equal(isAbsolute(sample[field]), false, `${field} must be portable`);
      assert((await stat(resolve(completed.rootDirectory, sample[field]))).size > 0);
    }
  }
  const verification = { status: 'passed', monitorId: monitor.id, deviceId: serial, sampleCount: completed.sampleCount, crossProcessQuery: true, explicitRelease: true, relativeEvidencePaths: true };
  await writeFile(join(completed.rootDirectory, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify({ ...verification, evidence: completed.rootDirectory }));
} finally {
  if (monitor) {
    try { await observer.tool('release_monitor', { monitorId: monitor.id }); }
    catch {}
  }
  await owner.close(); await observer.close();
}
