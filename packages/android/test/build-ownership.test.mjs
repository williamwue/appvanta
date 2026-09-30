import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireBuildProject } from '../dist/build-ownership.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-build-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('independent processes compete for one persistent project ownership', async t => {
  const base = await fixture(t);
  const project = join(base, 'project');
  await mkdir(project);
  const root = join(base, 'alias');
  await symlink(project, root, process.platform === 'win32' ? 'junction' : 'dir');
  const url = new URL('../dist/build-ownership.js', import.meta.url).href;
  const code = `import { acquireBuildProject } from ${JSON.stringify(url)};
    try { const handle = await acquireBuildProject(process.argv[1]); console.log(JSON.stringify(handle.owner)); }
    catch (error) { if (error.code !== 'BUILD_PROJECT_BUSY') throw error; console.log('busy'); }`;
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', code, index % 2 ? root : project], { timeout: 15000 })));
  assert.equal(results.filter(result => result.stdout.trim() === 'busy').length, 5);
  const winner = JSON.parse(results.find(result => result.stdout.trim() !== 'busy').stdout);
  assert.equal(winner.projectDirectory, await realpath(root));
  await assert.rejects(acquireBuildProject(root), { code: 'BUILD_PROJECT_BUSY' });
});

test('only confirmed terminal cleanup releases ownership and archives the result', async t => {
  const root = await fixture(t);
  const owner = await acquireBuildProject(root);
  await assert.rejects(acquireBuildProject(root), { code: 'BUILD_PROJECT_BUSY' });
  const result = await owner.finish({ execution: 'cancelled', cleanup: 'verified' });
  assert.equal(result.released, true);
  assert.deepEqual(JSON.parse(await readFile(join(result.recordDirectory, 'outcome.json'), 'utf8')).outcome,
    { execution: 'cancelled', cleanup: 'verified' });
  const successor = await acquireBuildProject(root);
  await assert.rejects(owner.finish({ execution: 'succeeded', cleanup: 'verified' }), /already finalized/);
  await assert.rejects(acquireBuildProject(root), { code: 'BUILD_PROJECT_BUSY' });
  assert.notEqual(successor.owner.runId, owner.owner.runId);
  await successor.finish({ execution: 'failed', cleanup: 'verified' });
});

test('unknown execution and unverified cleanup each preserve the persistent gate', async t => {
  for (const outcome of [{ execution: 'unknown', cleanup: 'verified' }, { execution: 'cancelled', cleanup: 'unverified' }]) {
    const root = await fixture(t);
    const handle = await acquireBuildProject(root);
    assert.equal((await handle.finish(outcome)).released, false);
    await assert.rejects(acquireBuildProject(root), { code: 'BUILD_PROJECT_BUSY' });
  }
});

test('project aliases share ownership and linked state directories are rejected', async t => {
  const root = await fixture(t);
  const project = join(root, 'project');
  await mkdir(project);
  const alias = join(root, 'alias');
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const handle = await acquireBuildProject(project);
  await assert.rejects(acquireBuildProject(alias), { code: 'BUILD_PROJECT_BUSY' });
  await handle.finish({ execution: 'succeeded', cleanup: 'verified' });
  const other = join(root, 'other');
  await mkdir(other);
  await symlink(join(project, '.appvanta'), join(other, '.appvanta'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(acquireBuildProject(other), /real directory/);
});

test('partial acquisition and damaged ownership never authorize replacement or release', async t => {
  const root = await fixture(t);
  await mkdir(join(root, '.appvanta', 'android-build', 'active'), { recursive: true });
  await assert.rejects(acquireBuildProject(root), { code: 'BUILD_PROJECT_BUSY' });
  const other = await fixture(t);
  const handle = await acquireBuildProject(other);
  await writeFile(join(handle.recordDirectory, 'owner.json'), '{}');
  await assert.rejects(handle.finish({ execution: 'succeeded', cleanup: 'verified' }), /Ownership changed/);
  await assert.rejects(acquireBuildProject(other), { code: 'BUILD_PROJECT_BUSY' });
});

test('concurrent finalization has one writer and outcome persistence failure retains ownership', async t => {
  const root = await fixture(t);
  const handle = await acquireBuildProject(root);
  const results = await Promise.allSettled([
    handle.finish({ execution: 'succeeded', cleanup: 'verified' }),
    handle.finish({ execution: 'cancelled', cleanup: 'verified' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const successor = await acquireBuildProject(root);
  await mkdir(join(successor.recordDirectory, 'outcome.json'));
  await assert.rejects(successor.finish({ execution: 'succeeded', cleanup: 'verified' }));
  await assert.rejects(acquireBuildProject(root), { code: 'BUILD_PROJECT_BUSY' });
  const other = await acquireBuildProject(await fixture(t));
  assert.equal((await other.finish({ execution: 'failed', cleanup: 'verified' })).released, true);
});
