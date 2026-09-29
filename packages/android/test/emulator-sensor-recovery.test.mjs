import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

for (const scenario of ['restore-once', 'completed-later-change', 'corrupt-receipt', 'foreign-receipt', 'invalid-sequence', 'directory-restore', 'orphan-receipt', 'unexpected-file']) {
  test(`sensor recovery: ${scenario}`, async () => {
    await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/emulator-sensor-recovery.fixture.mjs', import.meta.url)), scenario], { timeout: 15000, windowsHide: true });
  });
}
