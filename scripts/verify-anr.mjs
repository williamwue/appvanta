import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AdbDriver } from '../packages/android/dist/index.js';
const device = process.argv[2];
assert(device, 'Specify device with ANR fixture installed');
const root = resolve('.appvanta/runs', `anr-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const adb = async (...args) => (await promisify(execFile)('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000 })).stdout.trim();
const driver = new AdbDriver({ artifactsDirectory: root });
const since = await adb('shell', 'date', '+%s.%N');
let outcome = { status: 'failed' };
try {
  await adb('shell', 'am', 'force-stop', 'dev.appvanta.input');
  const started = await adb('shell', 'am', 'start', '-W', '-n', 'dev.appvanta.input/.AnrActivity');
  assert(!/Error:|Activity not started/.test(started), started);
  await driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text: 'Trigger AppVanta ANR' }, timeoutMs: 10000 });
  const tapped = await driver.execute(device, { kind: 'tap', target: { kind: 'text', value: 'Trigger AppVanta ANR' } });
  assert(tapped.success, JSON.stringify(tapped));
  // A second input is queued behind the intentionally blocked UI thread.
  const input = await adb('shell', 'input', 'keyevent', '4').then(stdout => ({ stdout }), error => ({ error: String(error) }));
  const deadline = Date.now() + 40000;
  let result;
  while (Date.now() < deadline) {
    result = await driver.diagnoseRuntime(device, 'dev.appvanta.input', since);
    if (result.anrCount) {
      const details = JSON.parse(await readFile(result.diagnosticsPath, 'utf8'));
      if (details.anrStackStatus === 'matched') break;
    }
    await delay(1000);
  }
  assert.equal(result.anrCount, 1, JSON.stringify(result));
  const report = JSON.parse(await readFile(result.diagnosticsPath, 'utf8'));
  assert(report.incidents.some(event => event.kind === 'anr' && /Input dispatching timed out/i.test(JSON.stringify(event))));
  assert.equal(report.anrStackStatus, 'matched');
  const main = report.anrStacks[0].threads.find(thread => thread.name === 'main');
  assert(main.lines.some(line => line.includes('AnrActivity')));
  assert(main.lines.some(line => line.includes('SystemClock.sleep')));
  const unrelated = await driver.diagnoseRuntime(device, 'net.gsantner.markor', since);
  assert.equal(unrelated.anrCount, 0);
  outcome = { status: 'passed', since, input, result, report, unrelated };
} catch (error) { outcome.error = String(error); throw error; }
finally {
  await adb('shell', 'am', 'force-stop', 'dev.appvanta.input');
  await driver.launch(device, 'net.gsantner.markor');
  await writeFile(join(root, 'verification.json'), JSON.stringify(outcome, null, 2));
}
console.log(JSON.stringify({ status: 'passed', root }));
