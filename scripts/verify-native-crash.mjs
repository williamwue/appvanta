import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AdbDriver } from '../packages/android/dist/index.js';
const device = process.argv[2];
assert(device, 'Specify device with native fault fixture installed');
const root = resolve('.appvanta/runs', `native-crash-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const adb = async (...args) => (await promisify(execFile)('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000 })).stdout.trim();
const driver = new AdbDriver({ artifactsDirectory: root });
const since = await adb('shell', 'date', '+%s.%N');
let outcome = { status: 'failed' };
try {
  await adb('shell', 'am', 'force-stop', 'dev.appvanta.input');
  const started = await adb('shell', 'am', 'start', '-n', 'dev.appvanta.input/.NativeFaultActivity');
  assert(!/Error:|Activity not started/.test(started), started);
  let result, report;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    result = await driver.diagnoseRuntime(device, 'dev.appvanta.input', since);
    report = JSON.parse(await readFile(result.diagnosticsPath, 'utf8'));
    if (report.incidents.some(incident => incident.nativeStack)) break;
    await delay(500);
  }
  assert.equal(result.crashCount, 1, JSON.stringify(report));
  const incident = report.incidents[0];
  assert.match(incident.nativeStack.signal, /SIGABRT/);
  assert.equal(incident.nativeStack.processName, 'dev.appvanta.input');
  assert(incident.nativeStack.processId > 0);
  assert(incident.nativeStack.frames.length > 0);
  const unrelated = await driver.diagnoseRuntime(device, 'net.gsantner.markor', since);
  assert.equal(unrelated.crashCount, 0);
  const after = await driver.diagnoseRuntime(device, 'dev.appvanta.input', await adb('shell', 'date', '+%s.%N'));
  assert.equal(after.crashCount, 0);
  outcome = { status: 'passed', result, report, unrelated, after };
} catch (error) { outcome.error = String(error); throw error; }
finally {
  await adb('shell', 'am', 'force-stop', 'dev.appvanta.input');
  await driver.launch(device, 'net.gsantner.markor');
  await writeFile(join(root, 'verification.json'), JSON.stringify(outcome, null, 2));
}
console.log(JSON.stringify({ status: 'passed', root }));
