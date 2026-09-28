import test from 'node:test';
import assert from 'node:assert/strict';
import { AdbDriver } from '../dist/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('capture rejects invalid durations before invoking ADB', async () => {
  const driver = new AdbDriver({ adbPath: 'must-not-be-executed', artifactsDirectory: 'must-not-be-created' });
  for (const duration of [NaN, Infinity, -1, 0, 1.5, 181]) {
    await assert.rejects(driver.recordScreen('test-device', duration), /Duration must be an integer/);
  }
  for (const duration of [NaN, Infinity, -1, 0, 1.5, 61]) {
    await assert.rejects(driver.collectPerfetto('test-device', duration), /Duration must be an integer/);
  }
});

test('capture transport retries only timed-out ownership probes and retains unverified artifacts', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/capture-transport.fixture.mjs', import.meta.url))], { timeout: 15000, windowsHide: true });
  assert.match(stdout, /capture-transport: passed/);
});
