import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectDeviceLock } from '../packages/core/dist/index.js';
import { readEmulatorAcceleration } from '../packages/android/dist/emulator-sensors.js';
import { createAdbTcpRelay } from './adb-tcp-relay.mjs';

const device = process.argv[2]; assert(/^emulator-\d+$/.test(device));
assert.equal(await inspectDeviceLock(device), null);
const root = resolve('.appvanta/runs', `shake-transport-${Date.now()}`);
await mkdir(root, { recursive: true });
const original = await readEmulatorAcceleration('adb', device);
const close = value => value.every((item, index) => Math.abs(item - original[index]) < 0.0001);
const relay = await createAdbTcpRelay();
const action = { kind: 'shake', axis: 'y', amplitude: 12, cycles: 3, intervalMs: 1000 };
const code = `import {runAndroidAction} from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};const result=await runAndroidAction(${JSON.stringify(device)},${JSON.stringify(action)});process.send(result);`;
const owner = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, env: relay.environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const exited = once(owner, 'exit'); let stderr = ''; owner.stderr.on('data', bytes => { stderr += bytes; });
const resultMessage = once(owner, 'message', { signal: AbortSignal.timeout(90000) }).then(([result]) => ({ result }), error => ({ error }));
let runDirectory, during;
try {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await inspectDeviceLock(device);
    if (state?.lease.runDirectory) runDirectory = state.lease.runDirectory;
    during = await readEmulatorAcceleration('adb', device);
    if (!close(during)) break;
    if (owner.exitCode !== null || owner.signalCode !== null) throw new Error(`Owner exited before mutation: ${stderr}`);
    await delay(100);
  }
  assert(runDirectory && !close(during), 'Disconnect only after an observed mutation');
  relay.setOffline(true);
  const outcome = await resultMessage;
  if (outcome.error) throw outcome.error;
  await exited;
  const result = outcome.result;
  assert.equal(result.success, false); assert.equal(result.status, 'failed'); assert.equal(result.cleanupFailed, false);
  assert.equal(result.runDirectory, runDirectory);
  assert.equal(await inspectDeviceLock(device), null);
  const directory = join(runDirectory, 'fixtures/emulator-sensors');
  const entries = await readdir(directory);
  assert.equal(entries.filter(name => name.endsWith('.restored.json')).length, 1);
  assert(close(await readEmulatorAcceleration('adb', device)), 'Sensor control remains available when only the ADB server relay is disconnected');
  const steps = (await readFile(join(runDirectory, 'steps.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.match(steps[0].message, /screencap/);
  const operations = (await readFile(join(runDirectory, 'actions.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert(operations.some(operation => operation.phase === 'finished' && operation.status === 'passed'), 'Shake action must finish before failed post-action observation');
  const probe = () => promisify(execFile)('adb', ['-s', device, 'get-state'], { env: relay.environment, timeout: 10000, windowsHide: true });
  let offlineError;
  await assert.rejects(probe(), error => { offlineError = String(error); return true; });
  relay.setOffline(false);
  assert.equal((await probe()).stdout.trim(), 'device');
  assert(close(await readEmulatorAcceleration('adb', device)));
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', scope: 'adb-server-disconnect-with-independent-emulator-console', device, original, during, result, offlineError, relayDiagnostics: relay.diagnostics, limitations: ['This disconnect did not interrupt sensor control; sensor restoration failure and reconnect recovery remain unverified.', 'Covers host ADB client to server TCP transport, not emulator process loss, device-side transport or physical USB.', 'Parent observer uses the unaffected ADB connection.'] }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), stderr, runDirectory, lease: await inspectDeviceLock(device), relayDiagnostics: relay.diagnostics }, null, 2));
  throw error;
} finally {
  if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exited; }
  await relay.close();
}
