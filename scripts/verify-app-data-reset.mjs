import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runAndroidFlow } from '../packages/android/dist/flow.js';

const [device, packageName = 'net.gsantner.markor'] = process.argv.slice(2);
assert(device, 'Usage: verify-app-data-reset.mjs <device> [package]');
const adb = async (...args) => (await promisify(execFile)('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true })).stdout.trim();
assert.match(await adb('shell', 'pm', 'path', packageName), /^package:\//m);
assert.match(packageName, /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/);
const markerName = `appvanta-reset-${randomUUID()}.txt`;
const marker = `/sdcard/Android/data/${packageName}/files/${markerName}`;
await mkdir('.appvanta/probe', { recursive: true });
const localMarker = join('.appvanta/probe', markerName);
await writeFile(localMarker, markerName);
await adb('shell', 'mkdir', '-p', `/sdcard/Android/data/${packageName}/files`);
await adb('push', localMarker, marker);
assert.equal(await adb('shell', 'cat', marker), markerName);
await adb('shell', 'monkey', '-p', packageName, '1');
const result = await runAndroidFlow(device, {
  name: 'Application data reset verification',
  resetApplications: [packageName],
  steps: [{ description: 'Launch after reset', launchPackage: packageName, action: { kind: 'wait', condition: packageName === 'net.gsantner.markor' ? { kind: 'target-visible', target: { kind: 'resource-id', value: 'net.gsantner.markor:id/next' } } : { kind: 'app-running', packageName }, timeoutMs: 20000 } }],
});
assert.equal(result.status, 'passed', JSON.stringify(result));
await assert.rejects(adb('shell', 'test', '-e', marker), error => error.code === 1);
const record = JSON.parse(await readFile(join(result.runDirectory, 'fixtures/app-data-reset.json'), 'utf8'));
assert.equal(record.restorable, false);
assert.deepEqual(record.entries.map(entry => [entry.packageName, entry.status, entry.output]), [[packageName, 'cleared', 'Success']]);
const environment = JSON.parse(await readFile(join(result.runDirectory, 'environment.json'), 'utf8'));
assert(environment.applications.some(application => application.packageName === packageName && application.installed));
const audit = (await readFile(join(result.runDirectory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
assert(audit.some(event => event.action === 'clear-application-data' && event.outcome === 'passed'));
await writeFile(join(result.runDirectory, 'app-data-reset-verification.json'), JSON.stringify({ status: 'passed', marker, markerRemoved: true, result, record }, null, 2));
console.log(JSON.stringify({ status: 'passed', runDirectory: result.runDirectory }));
