import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseFlow, withDeviceLock } from '../packages/core/dist/index.js';
import { AdbDriver } from '../packages/android/dist/index.js';
import { collectFlowEnvironment } from '../packages/android/dist/environment.js';

const device = process.argv[2]; assert(device, 'Device ID required');
const root = resolve('.appvanta/runs', `environment-state-${Date.now()}`);
await mkdir(root, { recursive: true });
const remote = `/storage/emulated/0/AppVantaEnvironment${randomUUID()}.txt`;
const adb = async (...args) => (await promisify(execFile)('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true })).stdout.trim();
const sha = text => createHash('sha256').update(text).digest('hex');
const states = await withDeviceLock(device, async () => {
  assert.equal(await adb('shell', `test ! -e ${remote} && echo absent`), 'absent');
  const driver = new AdbDriver({ artifactsDirectory: root });
  const flow = parseFlow({ name: 'Environment state verification', applications: ['net.gsantner.markor'], files: [{ path: remote, content: 'unused fixture content' }], appOps: [{ packageName: 'net.gsantner.markor', operation: 'MANAGE_EXTERNAL_STORAGE', mode: 'allow' }], steps: [{ description: 'Not executed', action: { kind: 'back' } }] });
  let expectedHash;
  const states = [];
  try {
    const missing = await collectFlowEnvironment(driver, device, flow);
    assert.deepEqual(missing.files, [{ path: remote, exists: false }]);
    assert(missing.inputMethod.selected && missing.inputMethod.enabled.includes(missing.inputMethod.selected));
    assert.equal(missing.appOps.length, 1);
    states.push(missing);
    for (const text of ['Environment A\n', 'Environment B\n']) {
      const local = join(root, 'fixture.txt'); await writeFile(local, text);
      expectedHash = sha(text); await adb('push', local, remote);
      const state = await collectFlowEnvironment(driver, device, flow);
      assert.deepEqual(state.files, [{ path: remote, exists: true, sha256: expectedHash }]);
      assert.deepEqual(state.inputMethod, missing.inputMethod);
      assert.deepEqual(state.appOps, missing.appOps);
      states.push(state);
    }
  } finally {
    if (expectedHash) {
      const current = (await adb('shell', `sha256sum ${remote}`)).split(/\s+/)[0];
      assert.equal(current, expectedHash, 'Refuse to delete a fixture changed externally');
      await adb('shell', `rm ${remote}`);
      assert.equal(await adb('shell', `test ! -e ${remote} && echo absent`), 'absent');
    }
  }
  return states;
});
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, states, fixtureRemoved: true }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
