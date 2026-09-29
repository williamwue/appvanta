import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAdbTcpRelay } from './adb-tcp-relay.mjs';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectDeviceLock } from '../packages/core/dist/index.js';
import { recoverAndroidFlow, continueAndroidFlow } from '../packages/android/dist/recover-flow.js';

const device = process.argv[2]; assert(device, 'Device ID required');
const cancelRecovery = process.argv[3] === 'cancel-recovery';
const tracePullDisconnect = process.argv[3] === 'tcp-pull-trace-disconnect';
const pullDisconnect = process.argv[3] === 'tcp-pull-disconnect' || tracePullDisconnect;
const tcpDisconnect = process.argv[3] === 'tcp-disconnect' || pullDisconnect;
if (process.argv[3] && !cancelRecovery && !tcpDisconnect) throw new Error('Unknown recovery scenario');
const root = resolve('.appvanta/runs', `network-capture-recovery-${Date.now()}`); await mkdir(root, { recursive: true });
const adb = (...args) => execFileSync(process.env.ADB_PATH || 'adb', ['-s', device, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
const originalProxy = adb('shell', 'settings', 'get', 'global', 'http_proxy');
const mitmdump = resolve(process.env.APPVANTA_MITMDUMP ?? '.appvanta/proxy-venv/Scripts/mitmdump.exe');
assert((await stat(mitmdump)).isFile(), 'Set APPVANTA_MITMDUMP to the installed mitmdump executable');
const flow = { name: 'Interrupted network and captures', network: { python: 'python', mitmdump, port: 18089 },
  capture: { screenSeconds: 180, perfettoSeconds: 60 }, steps: [{ description: 'Never execute after interruption', action: { kind: 'back' } }] };
const code = `import {runAndroidFlow} from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};
let run;const result=await runAndroidFlow(${JSON.stringify(device)},${JSON.stringify(flow)},undefined,async root=>{run=root;},{drain:async()=>[],finish:async()=>{},beforeStep:async()=>{process.send({run});await new Promise(()=>setInterval(()=>{},1000));}});throw new Error(JSON.stringify(result));`;
const relay = tcpDisconnect ? await createAdbTcpRelay() : undefined;
const owner = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, ...(relay ? { env: relay.environment } : {}), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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
  if (pullDisconnect) {
    const records = await Promise.all((await readdir(join(message.run, 'captures'))).filter(name => name.endsWith('.capture.json')).map(async name => JSON.parse(await readFile(join(message.run, 'captures', name), 'utf8'))));
    const screen = records.find(record => record.kind === 'screen');
    assert(screen, 'Screen capture record required');
    const deadline = Date.now() + 20000;
    let bytes = 0;
    while (Date.now() < deadline) {
      const result = await promisify(execFile)(process.env.ADB_PATH || 'adb', ['-s', device, 'shell', `test -f ${screen.remote} && stat -c %s ${screen.remote} || echo 0`], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      bytes = Number(result.stdout.trim());
      if (bytes >= 2) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert(bytes >= 2, 'Screen capture must contain bytes before testing mid-pull disconnection');
    await writeFile(join(root, 'capture-ready.json'), JSON.stringify({ remote: screen.remote, bytes, observedAt: new Date().toISOString() }, null, 2));
  }
  process.kill(network.workerPid, 'SIGKILL'); owner.kill('SIGKILL'); await exited;
  const state = await inspectDeviceLock(device); assert.equal(state.owner, 'dead'); assert.equal(state.lease.pid, owner.pid);
  let cancellation;
  let disconnection;
  const recoverViaRelay = async () => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import {recoverAndroidFlow} from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)}; console.log(JSON.stringify(await recoverAndroidFlow(${JSON.stringify(device)},${JSON.stringify(state.lease.token)})));`],
    { env: relay.environment, windowsHide: true, timeout: 120000, encoding: 'utf8' })).stdout);
  if (tcpDisconnect) {
    if (pullDisconnect) {
      const records = await Promise.all((await readdir(join(message.run, 'captures'))).filter(name => name.endsWith('.capture.json')).map(async name => JSON.parse(await readFile(join(message.run, 'captures', name), 'utf8'))));
      relay.interruptNextPull(records.filter(record => record.kind === (tracePullDisconnect ? 'trace' : 'screen')).map(record => record.remote));
    } else relay.setOffline(true);
    let failure;
    try { await recoverViaRelay(); assert.fail('Offline recovery unexpectedly succeeded'); }
    catch (error) { assert.match(String(error), pullDisconnect ? /Environment recovery incomplete/ : /connection reset|protocol fault/i); failure = String(error); }
    if (pullDisconnect) assert(relay.interruptedPull?.deliveredPayloadBytes === 1, 'Expected an interrupted DATA frame');
    assert.deepEqual((await inspectDeviceLock(device)).lease, state.lease);
    assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), network.sessionProxy);
    const retained = [];
    const alreadyRecovered = [];
    for (const name of (await readdir(join(message.run, 'captures'))).filter(name => name.endsWith('.capture.json'))) {
      const record = JSON.parse(await readFile(join(message.run, 'captures', name), 'utf8'));
      if (tracePullDisconnect && record.kind === 'screen') {
        assert.equal(record.cleaned, true);
        assert.equal(record.status, 'recovered');
        const preserved = record.preserved.find(item => item.path === `recovered/${record.artifact}`);
        assert(preserved && preserved.bytes > 0);
        assert.equal((await stat(join(message.run, 'captures', preserved.path))).size, preserved.bytes);
        assert.equal(adb('shell', `test ! -e ${record.remote} -a ! -e ${record.control}.pid && echo absent`), 'absent');
        alreadyRecovered.push({ artifact: record.artifact, preserved });
        continue;
      }
      assert.notEqual(record.cleaned, true);
      if (record.remote === relay.interruptedPull?.remote) {
        assert(record.transportErrors?.some(error => error.phase === 'recovery-pull'));
        assert.match(record.cleanupError, /remote artifact retained/);
      }
      assert.equal(adb('shell', `test -e ${record.remote} -a -e ${record.control}.pid && echo retained`), 'retained');
      retained.push({ artifact: record.artifact, remote: record.remote });
    }
    assert.equal(retained.length, tracePullDisconnect ? 1 : 2);
    assert.equal(alreadyRecovered.length, tracePullDisconnect ? 1 : 0);
    disconnection = { failure, retainedToken: state.lease.token, retained, alreadyRecovered, proxyUnchanged: true, interruptedPull: relay.interruptedPull };
    await writeFile(join(root, 'disconnected-recovery.json'), JSON.stringify(disconnection, null, 2));
    relay.setOffline(false);
  }
  if (cancelRecovery) {
    const controller = new AbortController();
    let timer, operationStarted = false, recoveryEntered = false;
    try {
      await assert.rejects(continueAndroidFlow(device, state.lease.token, async () => { operationStarted = true; }, async () => {
        recoveryEntered = true;
        timer = setTimeout(() => controller.abort(new Error('Verifier cancelled during cleanup')), 250);
      }, controller.signal), /Verifier cancelled during cleanup/);
    } finally { clearTimeout(timer); }
    assert(recoveryEntered && controller.signal.aborted);
    assert.equal(operationStarted, false);
    assert.deepEqual((await inspectDeviceLock(device)).lease, state.lease, 'Cancelled cleanup must not transfer ownership');
    assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), originalProxy);
    for (const name of (await readdir(join(message.run, 'captures'))).filter(name => name.endsWith('.capture.json'))) {
      assert.equal(JSON.parse(await readFile(join(message.run, 'captures', name), 'utf8')).cleaned, true);
    }
    cancellation = { recoveryEntered, aborted: true, operationStarted, retainedToken: state.lease.token, proxyRestoredBeforeReturn: true, capturesCleanedBeforeReturn: true };
    await writeFile(join(root, 'cancelled-recovery.json'), JSON.stringify(cancellation, null, 2));
  }
  const result = tcpDisconnect ? await recoverViaRelay() : await recoverAndroidFlow(device, state.lease.token);
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
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', originalProxy, run: message.run, cancellation, disconnection, result, takeover, captures }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), originalProxy, lease: await inspectDeviceLock(device) }, null, 2));
  throw error;
} finally {
  if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exited; }
  await relay?.close();
}
