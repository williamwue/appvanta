import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const scenario of ['clear', 'external-effect', 'partial', 'marker-denied', 'unsafe-child']) {
  test(`pre-Flow bound lease recovery: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'appvanta-pre-flow-recovery-'));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/pre-flow-recovery.fixture.mjs', import.meta.url)), scenario], { cwd: root, timeout: 15000, windowsHide: true });
      assert.match(stdout, new RegExp(`${scenario}: passed`));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
