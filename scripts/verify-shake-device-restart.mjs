import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectDeviceLock, withDeviceLock } from '../packages/core/dist/index.js';
import { listAndroidAvds } from '../packages/android/dist/index.js';
import { readEmulatorAcceleration } from '../packages/android/dist/emulator-sensors.js';

const [device, avd, gpu = 'host'] = process.argv.slice(2);
assert(/^emulator-\d+$/.test(device) && /^[A-Za-z0-9_.-]+$/.test(avd));
assert(['host', 'auto', 'software', 'swiftshader', 'swiftshader_indirect', 'lavapipe'].includes(gpu));
const port = Number(device.slice('emulator-'.length));
assert(port >= 5554 && port <= 5682 && port % 2 === 0);
const root = resolve('.appvanta/runs', `shake-device-restart-${Date.now()}`);
await mkdir(root, { recursive: true });
const adb = async (...args) => (await promisify(execFile)('adb', ['-s', device, ...args], { timeout: 10000, windowsHide: true })).stdout.trim();
const close = (a, b) => a.every((value, index) => Math.abs(value - b[index]) < 0.0001);
await withDeviceLock(`avd:${avd}`, async () => {
  assert.equal(await inspectDeviceLock(device), null);
  assert.equal((await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim(), avd);
  const inventory = await listAndroidAvds(); assert(inventory.avds.some(item => item.name === avd));
  const original = await readEmulatorAcceleration('adb', device);
  const restartArgs = ['-avd', avd, '-port', String(port), '-no-window', '-no-audio', '-no-snapshot-save', '-gpu', gpu];
  let stopped = false, restartRequested = false, restartPid, startupError;
  const boot = async () => {
    if (!restartRequested) {
      const log = await open(join(root, 'emulator-restart.log'), 'wx');
      try {
        const emulator = spawn(inventory.executable, restartArgs, { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
        emulator.on('error', error => { startupError = error; });
        emulator.on('exit', (code, signal) => { startupError = new Error(`Restarted emulator exited: ${code ?? signal}`); });
        restartPid = emulator.pid; emulator.unref(); restartRequested = true;
      } finally { await log.close(); }
    }
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      try {
        if ((await adb('emu', 'avd', 'name')).split(/\r?\n/)[0].trim() === avd && await adb('shell', 'getprop', 'sys.boot_completed') === '1') return;
      } catch {}
      await delay(500);
    }
    throw new Error(`Restart did not become ready; inspect ${root}`);
  };
  const action = { kind: 'shake', axis: 'x', amplitude: 12, cycles: 20, intervalMs: 1000 };
  const code = `import {runAndroidAction} from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};process.send(await runAndroidAction(${JSON.stringify(device)},${JSON.stringify(action)}));`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(owner, 'exit'); let stderr = ''; owner.stderr.on('data', bytes => { stderr += bytes; });
  const finished = once(owner, 'message', { signal: AbortSignal.timeout(90000) }).then(([result]) => ({ result }), error => ({ error }));
  let runDirectory, during;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = await inspectDeviceLock(device);
      if (state?.lease.runDirectory) runDirectory = state.lease.runDirectory;
      during = await readEmulatorAcceleration('adb', device);
      if (!close(during, original)) break;
      if (owner.exitCode !== null || owner.signalCode !== null) throw new Error(`Owner exited: ${stderr}`);
      await delay(100);
    }
    assert(runDirectory && !close(during, original));
    await writeFile(join(root, 'restart-intent.json'), JSON.stringify({ device, avd, original, during, runDirectory, executable: inventory.executable, restartArgs }, null, 2));
    stopped = true;
    await adb('emu', 'kill');
    console.log('Emulator shutdown requested after observed sensor change');
    const outcome = await finished;
    if (outcome.error) throw outcome.error;
    await exited;
    assert.equal(outcome.result.status, 'failed'); assert.equal(outcome.result.cleanupFailed, true);
    const state = await inspectDeviceLock(device);
    assert.equal(state.owner, 'dead'); assert.equal(state.lease.pid, owner.pid);
    const directory = join(runDirectory, 'fixtures/emulator-sensors');
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.restored.json')).length, 0);
    await assert.rejects(readEmulatorAcceleration('adb', device));
    const recover = () => promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'recover-flow', device, state.lease.token], { timeout: 120000, windowsHide: true });
    let offlineError;
    await assert.rejects(recover(), error => { offlineError = String(error); return true; });
    assert.deepEqual((await inspectDeviceLock(device)).lease, state.lease);
    console.log('Offline sensor cleanup failed and exact lease retained; restarting same AVD');
    await boot();
    const afterBoot = await readEmulatorAcceleration('adb', device);
    const recovery = JSON.parse((await recover()).stdout);
    assert.equal(recovery.status, 'recovered');
    assert(recovery.steps.some(step => step.fixture === 'emulator-sensors' && step.status === 'passed'));
    assert(close(await readEmulatorAcceleration('adb', device), original));
    assert.equal(await inspectDeviceLock(device), null);
    await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, avd, original, during, afterBoot, runDirectory, result: outcome.result, offlineError, recovery, restartPid, restartArgs, limitations: ['Controlled emulator shutdown/restart only, not physical USB or OEM.', 'Same AVD identity and default original acceleration; other restart-state conflicts remain subject to refusal.'] }, null, 2));
    console.log(JSON.stringify({ status: 'passed', root }));
  } catch (error) {
    await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), stderr, runDirectory, lease: await inspectDeviceLock(device), restartRequested, restartPid }, null, 2));
    throw error;
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exited; }
    if (stopped && !restartRequested) await boot();
  }
});
