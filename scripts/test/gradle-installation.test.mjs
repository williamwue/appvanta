import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveGradleInstallation } from '../gradle-installation.mjs';

test('pinned Gradle selection skips stale environment installations but rejects an invalid explicit path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-gradle-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stale = join(root, 'stale'), valid = join(root, 'pinned Gradle');
  await mkdir(join(valid, 'lib'), { recursive: true });
  await mkdir(stale);
  await writeFile(join(valid, 'lib/gradle-gradle-cli-main-8.13.jar'), 'fixture');
  const env = { GRADLE_HOME: stale, PATH: [join(stale, 'bin'), join(valid, 'bin')].join(delimiter) };
  assert.equal(resolveGradleInstallation(undefined, env).home, valid);
  assert.equal(resolveGradleInstallation(undefined, { GRADLE_HOME: valid }).home, valid);
  assert.equal(resolveGradleInstallation(valid, env).source, 'argument');
  assert.throws(() => resolveGradleInstallation(stale, env), /explicit/);
  assert.throws(() => resolveGradleInstallation(undefined, { GRADLE_HOME: stale }), /8.13/);
});
