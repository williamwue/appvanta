import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withDeviceLock, bindDeviceLockRun, inspectDeviceLock } from '../packages/core/dist/index.js';

const device = process.argv[2]; assert(device, 'Device ID required');
const root = resolve('.appvanta/runs', `proxy-reconnect-${Date.now()}`);
await mkdir(root, { recursive: true });
const result = await withDeviceLock(device, async () => {
  await bindDeviceLockRun(device, root);
  try {
    const { stdout } = await promisify(execFile)('python', ['scripts/verify-proxy-reconnect.py', '--device', device,
      '--output', root, '--runtime', 'packages/android/dist/runtime'], { windowsHide: true, timeout: 90000, encoding: 'utf8' });
    const report = JSON.parse(stdout);
    assert.equal(report.status, 'passed'); assert.equal(report.proxyRestored, true);
    return report;
  } catch (error) {
    await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), stdout: error.stdout, stderr: error.stderr }, null, 2));
    throw error;
  }
});
assert.equal(await inspectDeviceLock(device), null);
console.log(JSON.stringify({ status: result.status, root, scope: 'Real emulator settings; transport failures injected in packaged recovery callback, not physical disconnection' }));
