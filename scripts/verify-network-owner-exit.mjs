import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startNetwork } from '../packages/android/dist/network-session.js';

const serial = process.argv[2] ?? 'emulator-5554';
const root = resolve('.appvanta/runs', `network-owner-exit-${Date.now()}`);
await mkdir(root, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 20000 }).trim();
const original = adb('shell', 'settings', 'get', 'global', 'http_proxy');
const config = { python: 'python', mitmdump: resolve('.appvanta/proxy-venv/Scripts/mitmdump.exe'), port: 18089 };
const module = pathToFileURL(resolve('packages/android/dist/network-session.js')).href;
const source = `import { startNetwork } from ${JSON.stringify(module)}; await startNetwork(${JSON.stringify(config)}, ${JSON.stringify(serial)}, ${JSON.stringify(root)}); console.log('READY'); setInterval(() => {}, 1000);`;
const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
owner.stdout.on('data', chunk => { output += chunk; });
owner.stderr.on('data', chunk => { output += chunk; });
const exited = new Promise(done => owner.once('exit', done));
const killOwner = () => {
  if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${owner.pid} -Force`], { windowsHide: true });
  else owner.kill('SIGKILL');
};
const waitFor = async (check, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${output}`);
};
const summary = async () => {
  try { return JSON.parse(await readFile(join(root, 'network/summary.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
};
try {
  await waitFor(() => {
    if (owner.exitCode !== null) throw new Error(`Owner exited before ready: ${output}`);
    return output.includes('READY');
  });
  assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), `10.0.2.2:${config.port}`);
  killOwner();
  await exited;
  const result = await waitFor(summary);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.proxyRestored, true);
  assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), original);
  const recovery = JSON.parse(await readFile(join(root, 'network/recovery.json'), 'utf8'));
  await waitFor(() => {
    try { process.kill(recovery.proxyPid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 10000);
  // Reuse the same port to prove cleanup released the listener, then exercise
  // ordinary cooperative stop after the detached-worker change.
  const normalRoot = join(root, 'normal');
  const session = await startNetwork(config, serial, normalRoot);
  await session.stop();
  const normal = JSON.parse(await readFile(join(normalRoot, 'network/summary.json'), 'utf8'));
  assert.equal(normal.status, 'captured');
  assert.equal(normal.proxyRestored, true);
  assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), original);
  const conflictRoot = join(root, 'conflict');
  const conflictSession = await startNetwork(config, serial, conflictRoot);
  let conflict;
  try {
    adb('shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:18999');
    await assert.rejects(conflictSession.stop(), /refusing to overwrite/);
    assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), '127.0.0.1:18999');
    conflict = JSON.parse(await readFile(join(conflictRoot, 'network/summary.json'), 'utf8'));
    assert.equal(conflict.status, 'failed');
    assert.equal(conflict.proxyRestored, false);
  } finally {
    if (original === 'null') adb('shell', 'settings', 'delete', 'global', 'http_proxy');
    else adb('shell', 'settings', 'put', 'global', 'http_proxy', original);
  }
  assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), original);
  const damagedRoot = join(root, 'damaged-log');
  const damagedSession = await startNetwork(config, serial, damagedRoot);
  await writeFile(join(damagedRoot, 'network/requests.jsonl'), '{"partial":');
  await assert.rejects(damagedSession.stop(), /request evidence failed/);
  const damaged = JSON.parse(await readFile(join(damagedRoot, 'network/summary.json'), 'utf8'));
  assert.equal(damaged.status, 'failed');
  assert.equal(damaged.proxyRestored, true);
  assert.equal(damaged.proxyStopped, true);
  assert.deepEqual(damaged.cleanupErrors[0].lines, [1]);
  assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), original);
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', original, ownerPid: owner.pid, proxyPid: recovery.proxyPid, result, normal, conflict, damaged }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} finally {
  if (owner.exitCode === null && owner.signalCode === null) killOwner();
  await waitFor(summary);
}
