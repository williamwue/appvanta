import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const device = process.argv[2]; assert(device, 'Specify test device');
const root = `.appvanta/runs/diagnostics-check-${Date.now()}`;
await mkdir(root, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
const cli = (...args) => JSON.parse(execFileSync(process.execPath, ['packages/cli/dist/index.js', ...args], { encoding: 'utf8', timeout: 60000 }));
cli('launch', device, 'net.gsantner.markor');
const since = adb('shell', 'date', '+%s');
try {
  adb('shell', 'am', 'force-stop', 'dev.appvanta.input');
  adb('shell', 'am', 'start', '-n', 'dev.appvanta.input/.FaultActivity');
  let result, report;
  for (let attempt = 0; attempt < 10; attempt++) {
    result = cli('diagnose', device, 'dev.appvanta.input', since);
    report = JSON.parse(await readFile(result.diagnosticsPath, 'utf8'));
    if (result.crashCount > 0) break;
    await delay(500);
  }
  assert.equal(result.crashCount, 1);
  assert(report.incidents[0].stack.some(line => /AppVanta deliberate Java crash fixture/.test(line)));
  const unrelated = cli('diagnose', device, 'appvanta.nonexistent.app', since);
  assert.equal(unrelated.crashCount, 0); assert.equal(unrelated.anrCount, 0);
  await delay(1200);
  const after = cli('diagnose', device, 'dev.appvanta.input', adb('shell', 'date', '+%s'));
  assert.equal(after.crashCount, 0);
  await writeFile(`${root}/verification.json`, JSON.stringify({ result, unrelated, after, status: 'passed' }, null, 2));
  console.log(JSON.stringify({ root, status: 'passed' }));
} finally { cli('launch', device, 'net.gsantner.markor'); }
