import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const scenario of ['nested-unsafe', 'unbound-nested-unsafe', 'verified-flow', 'verified-nested-flow', 'marker-upgrade-denied', 'callback-marker-denied', 'journal-missing', 'journal-corrupt', 'journal-truncated', 'journal-foreign', 'journal-out-of-order', 'legacy-version-1']) {
  test(`bound Flow recovery: ${scenario}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'appvanta-nested-flow-recovery-'));
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/nested-flow-recovery.fixture.mjs', import.meta.url)), scenario], { cwd: root, timeout: 15000, windowsHide: true });
      assert.match(stdout, new RegExp(`${scenario}: passed`));
      const milestones = stderr.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      assert.equal(milestones.at(-1)?.phase, 'finished');
      t.diagnostic(JSON.stringify({ scenario, milestones }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
