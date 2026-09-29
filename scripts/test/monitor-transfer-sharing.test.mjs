import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

for (const mode of ['transient', 'persistent']) test(`monitor transfer handles ${mode} Windows delete-sharing denial`, { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const result = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/monitor-transfer-sharing.fixture.mjs', import.meta.url)), mode], { windowsHide: true, timeout: 18000 });
  t.diagnostic(result.stdout.trim());
});
