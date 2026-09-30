import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inspectAndroidProject } from '../dist/index.js';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

test('project inventory preserves files and distinguishes declarations from evaluated builds', async t => {
  const root = await fixture(t, {
    'settings.gradle.kts': 'include(":app")', 'build.gradle.kts': 'error("MUST NOT EXECUTE")',
    'app/build.gradle': 'plugins { id "com.android.application" }',
    'app/src/main/AndroidManifest.xml': '<manifest/>',
    'gradle/libs.versions.toml': '[versions]',
    'gradlew': 'exit 99', 'gradlew.bat': 'exit /b 99',
    'gradle/wrapper/gradle-wrapper.jar': 'fixture only', 'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=SECRET',
    'local.properties': 'sdk.dir=SECRET', 'gradle.properties': 'password=SECRET',
    'build/generated/build.gradle': 'ignored', 'node_modules/vendor/build.gradle': 'ignored',
  });
  const report = await inspectAndroidProject({ projectDirectory: root });
  assert.equal(report.version, 1);
  assert.equal(report.identification, 'android-gradle-candidate');
  assert.equal(report.scan.complete, true);
  assert.equal(report.wrapper.filesPresent, true);
  assert.equal(report.configurationEvaluated, false);
  assert.equal(report.buildExecuted, false);
  assert(report.files.some(file => file.path === 'app/build.gradle' && file.sha256.length === 64));
  assert(!report.files.some(file => file.path.startsWith('build/') || file.path.startsWith('node_modules/')));
  assert(!JSON.stringify(report).includes('SECRET'));
  assert.equal(await readFile(join(root, 'build.gradle.kts'), 'utf8'), 'error("MUST NOT EXECUTE")');
});

test('incomplete wrappers and ambiguous DSL files yield actionable findings', async t => {
  const root = await fixture(t, { 'build.gradle': '', 'build.gradle.kts': '', 'settings.gradle': '', 'gradlew': '' });
  const report = await inspectAndroidProject({ projectDirectory: root });
  assert.equal(report.identification, 'gradle-candidate');
  assert.equal(report.wrapper.filesPresent, false);
  assert(report.findings.some(item => item.code === 'wrapper-incomplete'));
  assert(report.findings.some(item => item.code === 'conflicting-build-scripts'));
});

test('build log findings retain line numbers without copying credentials or inferring success', async t => {
  const root = await fixture(t, { 'build.gradle': '', 'build.log': 'SECRET=token\n\u001b[31mSDK location not found.\u001b[0m\nAndroid Gradle plugin requires Java 17 to run.\nCould not resolve all files for configuration secret.\nManifest merger failed\nBUILD FAILED in 4s\n' });
  const report = await inspectAndroidProject({ projectDirectory: root, buildLogPath: join(root, 'build.log') });
  assert.equal(report.log.outcomeMarker, 'failed');
  assert.deepEqual(report.log.findings.map(item => [item.code, item.line]), [['sdk-location', 2], ['java-version', 3], ['dependency-resolution', 4], ['manifest-merger', 5]]);
  assert(!JSON.stringify(report).includes('token'));
  assert(!JSON.stringify(report).includes('secret'));
  await writeFile(join(root, 'build.log'), 'unrecognized compiler failure');
  const unknown = await inspectAndroidProject({ projectDirectory: root, buildLogPath: join(root, 'build.log') });
  assert.equal(unknown.log.outcomeMarker, 'unknown');
  assert.equal(unknown.log.findings.length, 0);
});

test('scan limits, linked directories and oversized logs remain explicit', async t => {
  const root = await fixture(t, { 'build.gradle': '', 'deep/a/b/c/d/e/f/g/h/build.gradle': '', 'build.log': 'x'.repeat(2 * 1024 * 1024 + 1) });
  const outside = await fixture(t, { 'build.gradle': 'outside' });
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = await inspectAndroidProject({ projectDirectory: root });
  assert.equal(report.scan.complete, false);
  assert(report.scan.skipped.some(item => item.reason === 'symbolic-link'));
  assert(report.scan.skipped.some(item => item.reason === 'depth-limit'));
  assert(!report.files.some(file => file.path.startsWith('linked/')));
  await assert.rejects(inspectAndroidProject({ projectDirectory: root, buildLogPath: join(root, 'build.log') }), /exceeds/);
});

test('missing projects and pre-cancelled scans fail; an empty directory stays unrecognized', async t => {
  const root = await fixture(t, {});
  assert.equal((await inspectAndroidProject({ projectDirectory: root })).identification, 'unrecognized');
  await assert.rejects(inspectAndroidProject({ projectDirectory: join(root, 'missing') }), /ENOENT/);
  await assert.rejects(inspectAndroidProject({ projectDirectory: root, signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
});
