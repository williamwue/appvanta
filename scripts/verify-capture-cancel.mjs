import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AdbDriver } from '../packages/android/dist/index.js';

const serial = process.argv[2];
assert(serial, 'Specify device');
const root = resolve('.appvanta/runs', `capture-cancel-${Date.now()}`);
await mkdir(root, { recursive: true });
const exec = promisify(execFile);
const shell = async command => (await exec('adb', ['-s', serial, 'shell', command], { timeout: 20000 })).stdout.trim();
const records = [];
for (const [kind, method] of [['screen', 'recordScreen'], ['trace', 'collectPerfetto']]) {
  const controller = new AbortController();
  const directory = join(root, kind);
  const before = new Set((await shell('ls /data/local/tmp/appvanta-*.pid 2>/dev/null || true')).split(/\r?\n/));
  const driver = new AdbDriver({ artifactsDirectory: directory, signal: controller.signal });
  // Attach failure handler immediately so abort cannot create an unhandled rejection.
  const pending = driver[method](serial, 30).then(value => ({ value }), error => ({ error: String(error) }));
  let control, pid;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const files = (await shell('ls /data/local/tmp/appvanta-*.pid 2>/dev/null || true')).split(/\r?\n/);
    control = files.find(file => !before.has(file) && file.includes(`appvanta-${kind}-`));
    if (control) {
      pid = await shell(`cat ${control}`);
      if (/^[1-9][0-9]*$/.test(pid)) break;
    }
    await delay(100);
  }
  assert(pid, 'Device process did not start');
  await delay(1000);
  const started = Date.now();
  controller.abort(new Error('verification cancellation'));
  const result = await pending;
  assert(result.error, 'Cancelled capture must not report success');
  const [file] = (await readdir(directory)).filter(file => file.endsWith('.capture.json'));
  const evidence = JSON.parse(await readFile(join(directory, file), 'utf8'));
  assert.equal(evidence.cancelled, true);
  assert.equal(evidence.cleaned, true, JSON.stringify(evidence));
  const cmdline = await shell(`if [ -r /proc/${pid}/cmdline ]; then tr '\\000' ' ' < /proc/${pid}/cmdline; fi`);
  assert(!cmdline.includes(evidence.remote), 'Device collector still alive');
  assert.equal(await shell(`test ! -e ${evidence.remote} && test ! -e ${control} && test ! -e ${evidence.control}.status && test ! -e ${evidence.control}.log && echo cleaned`), 'cleaned');
  records.push({ kind, elapsedMs: Date.now() - started, result, evidence });
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', records }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
