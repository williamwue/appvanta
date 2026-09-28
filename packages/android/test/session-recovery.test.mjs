import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverCaptures, recoverNetworkSession } from '../dist/index.js';

test('capture recovery is idempotent for validated completed records and rejects path substitution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-capture-recovery-'));
  const directory = join(root, 'captures');
  await mkdir(directory);
  const artifact = 'screen-11111111-1111-4111-8111-111111111111.mp4';
  const path = join(directory, `${artifact}.capture.json`);
  const record = {
    version: 2, kind: 'screen', device: 'test-device', artifact,
    remote: `/sdcard/${artifact}`, control: `/data/local/tmp/appvanta-${artifact}`,
    seconds: 5, status: 'passed', cancelled: false, cleaned: true,
    startedAt: '2026-09-22T00:00:00.000Z', finishedAt: '2026-09-22T00:00:05.000Z',
  };
  try {
    await writeFile(path, JSON.stringify(record));
    assert.deepEqual(await recoverCaptures('must-not-run', 'test-device', root), [{ artifact, status: 'already-clean' }]);
    await writeFile(path, JSON.stringify({ ...record, remote: '/sdcard/someone-else.mp4' }));
    await assert.rejects(recoverCaptures('must-not-run', 'test-device', root), /paths do not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('network recovery accepts only a summary that proves proxy restoration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-network-recovery-'));
  const directory = join(root, 'network');
  await mkdir(directory);
  try {
    await writeFile(join(directory, 'summary.json'), JSON.stringify({ status: 'interrupted', device: 'test-device', proxyRestored: true }));
    const result = await recoverNetworkSession('must-not-run', 'test-device', root);
    assert.equal(result.status, 'already-clean');
    assert.equal(result.evidence, join(directory, 'summary.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
