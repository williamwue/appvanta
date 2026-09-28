import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectDeviceLock } from '../packages/core/dist/index.js';
import { recoverAndroidFlow } from '../packages/android/dist/index.js';

const device = process.argv[2]; assert(device, 'Device ID required');
const root = resolve('.appvanta/runs', `network-capture-recovery-${Date.now()}`); await mkdir(root, { recursive: true });
const adb = (...args) => execFileSync(process.env.ADB_PATH || 'adb', ['-s', device, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
const originalProxy = adb('shell', 'settings', 'get', 'global', 'http_proxy');
const flow = { name: 'Interrupted network and captures', network: { python: 'python', mitmdump: resolve('.appvanta/proxy-venv/Scripts/mitmdump.exe'), port: 18089 },
  capture: { screenSeconds: 180, perfettoSeconds: 60 }, steps: [{ description: 'Never execute after interruption', action: { kind: 'back' } }] };
const code = `import {runAndroidFlow} from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};
let run;await runAndroidFlow(${JSON.stringify(device)},${JSON.stringify(flow)},undefined,async root=>{run=root;},{drain:async()=>[],finish:async()=>{},beforeStep:async()=>{process.send({run});await new Promise(()=>setInterval(()=>{},1000));}});`;
const owner = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const exited = once(owner, 'exit'); let stderr = ''; owner.stderr.on('data', data => { stderr += data; });
try {
  const [message] = await Promise.race([once(owner, 'message', { signal: AbortSignal.timeout(90000) }), exited.then(() => { throw new Error(stderr); })]);
  const network = JSON.parse(await readFile(join(message.run, 'network/recovery.json'), 'utf8'));
  assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), network.sessionProxy);
  const command = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${network.workerPid}").CommandLine`], { encoding: 'utf8', windowsHide: true })
    : execFileSync('ps', ['-p', String(network.workerPid), '-o', 'command='], { encoding: 'utf8' });
  assert(command.includes('capture-network.py'));
  assert(command.toLowerCase().replaceAll('\\', '/').includes(join(message.run, 'network').toLowerCase().replaceAll('\\', '/')));
  process.kill(network.workerPid, 'SIGKILL'); owner.kill('SIGKILL'); await exited;
  const state = await inspectDeviceLock(device); assert.equal(state.owner, 'dead'); assert.equal(state.lease.pid, owner.pid);
  const result = await recoverAndroidFlow(device, state.lease.token);
  assert.deepEqual(result.steps.map(step => [step.fixture, step.status]), [['capture', 'passed'], ['network', 'passed']]);
  assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), originalProxy);
  const takeover = JSON.parse(await readFile(join(message.run, 'network/takeover-recovery.json'), 'utf8'));
  assert.equal(takeover.proxyRestored, true);
  for (const pid of [network.workerPid, network.proxyPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const captures = [];
  for (const name of (await readdir(join(message.run, 'captures'))).filter(name => name.endsWith('.capture.json'))) {
    const record = JSON.parse(await readFile(join(message.run, 'captures', name), 'utf8'));
    assert.equal(record.cleaned, true); assert.equal(record.status, 'recovered');
    assert.equal(record.artifactValidity, 'unverified');
    const preserved = record.preserved.find(item => item.path === `recovered/${record.artifact}`);
    assert(preserved && preserved.bytes > 0, 'Interrupted capture must be preserved locally');
    assert.equal((await stat(join(message.run, 'captures', preserved.path))).size, preserved.bytes);
    assert.equal(adb('shell', `test ! -e ${record.remote} -a ! -e ${record.control}.pid && echo absent`), 'absent');
    captures.push(record);
  }
  assert.equal(captures.length, 2);
  assert.equal(await inspectDeviceLock(device), null);
  assert.notEqual(JSON.parse(await readFile(join(message.run, 'run.json'), 'utf8')).status, 'passed');
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', originalProxy, run: message.run, result, takeover, captures }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} finally {
  if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exited; }
}
