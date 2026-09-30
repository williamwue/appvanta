import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('AVD cancellation retains instances, records cancellation and releases startup locks', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/avd-cancellation.fixture.mjs', import.meta.url))], { timeout: 15000, windowsHide: true });
  assert.match(stdout, /passed/);
});
