import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeviceLock } from '../packages/core/dist/index.js';
const device = process.argv[2]; assert(device, 'Specify test device');
const name = `protocol-cancel-${Date.now()}`;
const root = resolve('.appvanta/runs', name);
await mkdir(root, { recursive: true });
const proxy = () => execFileSync('adb', ['-s', device, 'shell', 'settings', 'get', 'global', 'http_proxy'], { encoding: 'utf8', timeout: 20000 }).trim();
const originalProxy = proxy();
const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout });
const responses = new Map();
lines.on('line', text => { const item = JSON.parse(text); responses.set(item.id, item); });
const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const wait = async check => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error('Verification wait timed out');
};
let run;
try {
  send({ id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version: '1' } } });
  await wait(() => responses.get('init'));
  send({ method: 'notifications/initialized' });
  send({ id: 'long', method: 'tools/call', params: { name: 'run_flow', arguments: { deviceId: device, flow: {
    version: 1, name,
    network: { python: resolve('.appvanta/proxy-venv/Scripts/python.exe'), mitmdump: resolve('.appvanta/proxy-venv/Scripts/mitmdump.exe') },
    steps: [{ description: 'Long wait', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'appvanta.never' }, timeoutMs: 60000 } }],
  } } } });
  run = await wait(async () => {
    for (const entry of await readdir('.appvanta/runs')) {
      if (!entry.includes(device)) continue;
      const directory = resolve('.appvanta/runs', entry);
      try { if (JSON.parse(await readFile(join(directory, 'flow.json'), 'utf8')).name === name) return directory; } catch {}
    }
  });
  await wait(async () => { try { return (await readFile(join(run, 'actions.jsonl'), 'utf8')).includes('started'); } catch { return false; } });
  assert.notEqual(proxy(), originalProxy, 'Proxy was not configured before cancellation');
  const pingStart = Date.now();
  send({ id: 'ping', method: 'ping' });
  await wait(() => responses.get('ping'));
  const pingMs = Date.now() - pingStart;
  assert(pingMs < 3000, 'Ping blocked behind synchronous Flow');
  send({ method: 'notifications/cancelled', params: { requestId: 'long', reason: 'verification cancellation' } });
  await wait(async () => JSON.parse(await readFile(join(run, 'run.json'), 'utf8')).status === 'cancelled');
  await delay(200);
  assert.equal(proxy(), originalProxy);
  assert.equal(responses.has('long'), false);
  await withDeviceLock(device, async () => {});
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', run, pingMs, originalProxy, restoredProxy: proxy(), cancelledResponseSuppressed: true, leaseReleased: true }, null, 2));
  console.log(JSON.stringify({ root, status: 'passed', pingMs }));
} finally {
  // Let cancellation cleanup finish even when an assertion fails.
  send({ method: 'notifications/cancelled', params: { requestId: 'long' } });
  if (run) await wait(async () => ['passed', 'failed', 'cancelled'].includes(JSON.parse(await readFile(join(run, 'run.json'), 'utf8')).status)).catch(error => console.error(String(error)));
  child.kill(); lines.close();
}
