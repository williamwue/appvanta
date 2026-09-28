import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAndroidFlow } from '../packages/android/dist/flow.js';
const device = process.argv[2];
assert(device, 'Specify device with AppVanta input helper installed');
const root = resolve('.appvanta/runs', `flow-diagnostics-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const adb = (...args) => promisify(execFile)('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000 });
const flow = { name: 'Automatic diagnostics', diagnostics: { packages: ['net.gsantner.markor', 'dev.appvanta.input'] }, steps: [
  { description: 'Launch Markor', launchPackage: 'net.gsantner.markor' },
  { description: 'Verify Markor process', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'net.gsantner.markor' }, timeoutMs: 1000 } },
] };
const clean = await runAndroidFlow(device, flow);
assert.equal(clean.status, 'passed', JSON.stringify(clean));
let injection;
const crashed = await runAndroidFlow(device, flow, undefined, async directory => {
  injection = (async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        if ((await readFile(join(directory, 'actions.jsonl'), 'utf8')).includes('started')) {
          await adb('shell', 'am', 'force-stop', 'dev.appvanta.input');
          const launched = await adb('shell', 'am', 'start', '-n', 'dev.appvanta.input/.FaultActivity');
          assert(!/Error:|Activity not started/.test(launched.stdout), launched.stdout);
          return;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(50);
    }
    throw new Error('No running Flow action to inject fault');
  })();
  injection.catch(() => {});
});
await injection;
assert.equal(crashed.status, 'failed');
assert(crashed.steps.slice(0, 2).every(step => step.status === 'passed'), JSON.stringify(crashed));
assert.equal(crashed.steps.at(-1).description, 'Runtime diagnostics');
const summary = JSON.parse(await readFile(join(crashed.runDirectory, 'diagnostics/summary.json'), 'utf8'));
assert.equal(summary.results.find(item => item.packageName === 'dev.appvanta.input').crashCount, 1);
assert.equal(summary.results.find(item => item.packageName === 'net.gsantner.markor').crashCount, 0);
const fault = summary.results.find(item => item.packageName === 'dev.appvanta.input');
const details = JSON.parse(await readFile(join(crashed.runDirectory, fault.report), 'utf8'));
assert(details.incidents[0].stack.some(line => line.includes('AppVanta deliberate Java crash fixture')));
const after = await runAndroidFlow(device, flow);
assert.equal(after.status, 'passed', 'Previous run crash leaked into new run');
const controller = new AbortController();
let timer;
const cancelled = await runAndroidFlow(device, { ...flow, steps: [{ description: 'Wait for absent app', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'appvanta.nonexistent' }, timeoutMs: 30000 } }] }, controller.signal, async directory => {
  timer = setInterval(async () => {
    try { if ((await readFile(join(directory, 'actions.jsonl'), 'utf8')).includes('started')) controller.abort(); } catch {}
  }, 100);
}).finally(() => clearInterval(timer));
assert.equal(cancelled.status, 'cancelled');
assert.equal(JSON.parse(await readFile(join(cancelled.runDirectory, 'diagnostics/summary.json'), 'utf8')).status, 'passed');
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', clean, crashed, summary, after, cancelled }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
