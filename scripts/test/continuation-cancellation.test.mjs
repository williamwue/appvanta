import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { requestContinuationCancellation, watchContinuationCancellation } from '../../packages/mcp/dist/continuation-cancellation.js';
import { startContinuation } from '../../packages/mcp/dist/start-continuation.js';

test('already cancelled startup does not inspect or reserve a source task', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(startContinuation({ get() { assert.fail('must not inspect source'); } }, 'unused', 'unused', {}, controller.signal), { name: 'AbortError' });
});

test('durable cancellation reaches an active watcher and survives worker startup', async () => {
  const project = await mkdtemp(join(tmpdir(), 'appvanta-continuation-cancel-'));
  const id = randomUUID(), root = resolve(project, '.appvanta/continuations', id);
  await mkdir(root, { recursive: true });
  let watcher;
  try {
    watcher = await watchContinuationCancellation(root);
    assert.equal(watcher.signal.aborted, false);
    await requestContinuationCancellation(root);
    const deadline = Date.now() + 3000;
    while (!watcher.signal.aborted && Date.now() < deadline) await delay(20);
    assert.equal(watcher.signal.aborted, true);
    await watcher.stop(); watcher = undefined;
    // No request.json: cancellation must be observed before source lookup or recovery.
    const child = spawnSync(process.execPath, [resolve('packages/mcp/dist/continuation-worker.js'), id], {
      cwd: project, env: { ...process.env, APPVANTA_PROJECT_ROOT: project }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 1, child.stderr);
    const error = JSON.parse(await readFile(join(root, 'error.json'), 'utf8'));
    assert.match(error.error, /startup cancellation requested/);
    await assert.rejects(readFile(join(root, 'ready.json')), { code: 'ENOENT' });
  } finally {
    await watcher?.stop();
    await rm(project, { recursive: true, force: true });
  }
});
