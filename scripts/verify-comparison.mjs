import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const device = process.argv[2];
assert(device, 'Specify device');
const root = resolve('.appvanta/runs', `comparison-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const file = join(root, 'flow.json');
await writeFile(file, JSON.stringify({ version: 1, name: 'Compare Markor launches', steps: [{ description: 'Launch Markor', launchPackage: 'net.gsantner.markor', assertTarget: { kind: 'resource-id', value: 'net.gsantner.markor:id/nav_quicknote' } }] }));
const cli = (...args) => spawnSync(process.execPath, ['packages/cli/dist/index.js', ...args], { encoding: 'utf8', timeout: 120000 });
const runs = [];
for (let i = 0; i < 2; i++) {
  const result = cli('run-flow', device, file); assert.equal(result.status, 0, result.stderr);
  runs.push(JSON.parse(result.stdout).runDirectory);
}
const equal = cli('compare', ...runs);
assert.equal(equal.status, 0, equal.stderr);
assert.equal(JSON.parse(equal.stdout).scope, 'run');
const altered = join(root, 'altered-copy');
await cp(runs[1], altered, { recursive: true });
const metadata = JSON.parse(await readFile(join(altered, 'run.json'), 'utf8'));
await writeFile(join(altered, 'run.json'), JSON.stringify({ ...metadata, status: 'failed' }));
const failed = cli('compare', runs[0], altered);
assert.equal(failed.status, 1);
assert.equal(JSON.parse(failed.stdout).status, 'failed');
const stepsOnly = cli('compare', runs[0], altered, '--steps-only');
assert.equal(stepsOnly.status, 0);
assert.equal(JSON.parse(stepsOnly.stdout).scope, 'steps-only');
const environment = JSON.parse(await readFile(join(runs[1], 'environment.json'), 'utf8'));
assert(environment.applications.find(app => app.packageName === 'net.gsantner.markor').apks.every(apk => /^[a-f0-9]{64}$/.test(apk.sha256)));
const rejectedEnvironment = [];
for (const kind of ['apk', 'node', 'missing']) {
  const directory = join(root, `${kind}-copy`);
  await cp(runs[1], directory, { recursive: true });
  const changed = structuredClone(environment);
  if (kind === 'apk') changed.applications[0].apks[0].sha256 = '0'.repeat(64);
  if (kind === 'node') changed.host.node = 'v0.0.0';
  if (kind === 'missing') changed.applications = [];
  const bytes = JSON.stringify(changed);
  await writeFile(join(directory, 'environment.json'), bytes);
  // Keep local integrity valid to test semantic differences, not only hash failure.
  const run = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  run.recording['environment.json'] = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, 'run.json'), JSON.stringify(run));
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  report.metadata = run;
  await writeFile(join(directory, 'report.json'), JSON.stringify(report));
  const rejected = cli('compare', runs[0], directory);
  assert.equal(rejected.status, 1);
  const result = JSON.parse(rejected.stdout);
  assert(result.differences.some(message => /application|Host tools/.test(message)), JSON.stringify(result));
  rejectedEnvironment.push({ kind, result });
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ runs, environment, rejectedEnvironment, equal: JSON.parse(equal.stdout), rejectedFinalState: JSON.parse(failed.stdout), explicitStepsOnly: JSON.parse(stepsOnly.stdout) }, null, 2));
console.log(JSON.stringify({ root, status: 'passed' }));
