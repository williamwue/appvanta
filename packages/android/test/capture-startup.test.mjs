import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('capture final evidence failure and uncertain PID cleanup retain the Flow lease', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./helpers/capture-evidence-failure.fixture.mjs', import.meta.url))], { timeout: 15000, windowsHide: true });
  assert.match(stdout, /capture-evidence-failure: passed/);
});

test('capture startup propagates unverified rollback to Flow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-capture-startup-'));
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await copyFile(new URL('../dist/flow-capture.js', import.meta.url), join(root, 'flow-capture.js'));
    await writeFile(join(root, 'capture.js'), `export async function captureArtifact() { throw Object.assign(new Error('remote cleanup failed'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); }`);
    await writeFile(join(root, 'segmented-screen.js'), `export async function captureScreenSegments() { throw new Error('unexpected segmented capture'); }`);
    const { startFlowCapture } = await import(pathToFileURL(join(root, 'flow-capture.js')).href);
    await assert.rejects(startFlowCapture({ screenSeconds: 1 }, 'device', root), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
