import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { resolve, join } from 'node:path';
import { withDeviceLock, bindDeviceLockRun, inspectDeviceLock } from '../packages/core/dist/index.js';

const device = process.argv[2]; assert(device, 'Device ID required');
const tcp = process.argv[3] === 'tcp';
if (process.argv[3] && !tcp) throw new Error('Usage: verify-proxy-reconnect.mjs <device> [tcp]');
const root = resolve('.appvanta/runs', `proxy-reconnect-${Date.now()}`);
await mkdir(root, { recursive: true });
const sockets = new Set();
let offline = false, controller, updating = false, sequence = 0;
const relay = createServer(client => {
  if (offline) { client.destroy(); return; }
  const server = connect({ host: '127.0.0.1', port: 5037 });
  for (const socket of [client, server]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }
  client.on('error', () => server.destroy()); server.on('error', () => client.destroy());
  client.on('close', () => server.destroy()); server.on('close', () => client.destroy());
  client.pipe(server); server.pipe(client);
});
if (tcp) {
  await new Promise((done, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', done); });
  controller = setInterval(async () => {
    if (updating) return;
    updating = true;
    try {
      const request = JSON.parse(await readFile(join(root, 'transport-request.json'), 'utf8'));
      if (request.sequence <= sequence) return;
      offline = request.offline;
      if (offline) for (const socket of sockets) socket.destroy();
      const temporary = join(root, 'transport-ack.tmp');
      await writeFile(temporary, JSON.stringify(request)); await rename(temporary, join(root, 'transport-ack.json'));
      sequence = request.sequence;
    } catch (error) { if (error.code !== 'ENOENT') process.stderr.write(String(error)); }
    finally { updating = false; }
  }, 10);
}
try {
const result = await withDeviceLock(device, async () => {
  await bindDeviceLockRun(device, root);
  try {
    const { stdout } = await promisify(execFile)('python', ['scripts/verify-proxy-reconnect.py', '--device', device,
      '--output', root, '--runtime', 'packages/android/dist/runtime', ...(tcp ? ['--adb-port', String(relay.address().port)] : [])], { windowsHide: true, timeout: 90000, encoding: 'utf8' });
    const report = JSON.parse(stdout);
    assert.equal(report.status, 'passed'); assert.equal(report.proxyRestored, true);
    return report;
  } catch (error) {
    await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), stdout: error.stdout, stderr: error.stderr }, null, 2));
    throw error;
  }
});
assert.equal(await inspectDeviceLock(device), null);
console.log(JSON.stringify({ status: result.status, root, scope: tcp ? 'Real ADB client-server TCP relay interruption; not device USB disconnection' : 'Real emulator settings; transport failures injected in packaged recovery callback, not physical disconnection' }));
} finally {
  clearInterval(controller);
  for (const socket of sockets) socket.destroy();
  if (tcp) await new Promise(done => relay.close(done));
}
