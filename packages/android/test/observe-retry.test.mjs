import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('observation retries transient null roots with retained attempts and cancellation', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/observe-retry.fixture.mjs', import.meta.url))], { timeout: 15000, windowsHide: true });
  assert.match(stdout, /observe-retry: passed/);
});
