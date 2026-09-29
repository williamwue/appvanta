import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('app-running distinguishes absent processes from failed ADB transport', async () => {
  await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/app-running-condition.fixture.mjs', import.meta.url))], { timeout: 15000, windowsHide: true });
});
