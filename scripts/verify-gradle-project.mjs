import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectAndroidProject } from '../packages/android/dist/index.js';
import { mcpExchange } from './test/helpers/mcp-exchange.mjs';
import { resolveGradleInstallation } from './gradle-installation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installation = resolveGradleInstallation(process.argv[2]);
if (!process.env.JAVA_HOME) throw new Error('Set JAVA_HOME');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('Set ANDROID_HOME or ANDROID_SDK_ROOT');
const id = `gradle-project-${Date.now()}`;
const project = join(root, '.appvanta/gradle-projects', id);
const evidence = join(root, '.appvanta/runs', id);
await mkdir(evidence, { recursive: true });
const java = join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const launcher = installation.launcher;
const runFile = promisify(execFile);
const source = {
  'settings.gradle.kts': `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "AppVantaBuildVerification"
include(":app", ":library")
`,
  'build.gradle.kts': `plugins {
    id("com.android.application") version "8.13.2" apply false
    id("com.android.library") version "8.13.2" apply false
}
`,
  'app/build.gradle.kts': `plugins { id("com.android.application") }
android {
    namespace = "dev.appvanta.buildprobe"
    compileSdk = 35
    defaultConfig { applicationId = "dev.appvanta.buildprobe"; minSdk = 23; targetSdk = 35; versionCode = 1; versionName = "1" }
}
dependencies {
    implementation(project(":library"))
    if (providers.gradleProperty("missingDependency").isPresent) implementation("dev.appvanta.missing:never:0.0.0")
}
`,
  'library/build.gradle': `plugins { id 'com.android.library' }
android { namespace 'dev.appvanta.buildlibrary'; compileSdk 35; defaultConfig { minSdk 23 } }
`,
  'library/src/main/AndroidManifest.xml': '<manifest/>',
  'library/src/main/java/dev/appvanta/buildlibrary/Label.java': 'package dev.appvanta.buildlibrary; public final class Label { public static String value() { return "AppVanta Gradle verification"; } }',
  'app/src/main/java/dev/appvanta/buildprobe/MainActivity.java': 'package dev.appvanta.buildprobe; public final class MainActivity extends android.app.Activity { public void onCreate(android.os.Bundle state) { super.onCreate(state); android.widget.TextView text = new android.widget.TextView(this); text.setText(dev.appvanta.buildlibrary.Label.value()); setContentView(text); } }',
  'app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="AppVanta Build Probe"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>',
};
for (const [path, content] of Object.entries(source)) {
  await mkdir(dirname(join(project, path)), { recursive: true });
  await writeFile(join(project, path), content, { flag: 'wx' });
}
await writeFile(join(evidence, 'sources.json'), JSON.stringify(source, null, 2));
const report = { status: 'running', project, evidence, gradleVersion: '8.13', agpVersion: '8.13.2', installation: { ...installation, environmentHome: process.env.GRADLE_HOME ?? null, launcherSha256: createHash('sha256').update(await readFile(launcher)).digest('hex') }, cases: [] };
const persist = () => writeFile(join(evidence, 'verification.json'), JSON.stringify(report, null, 2));
async function gradle(name, tasks, environment = process.env) {
  const args = ['-classpath', launcher, 'org.gradle.launcher.GradleMain', '--no-daemon', '--console=plain', '--max-workers=2', ...(process.env.APPVANTA_GRADLE_OFFLINE === '1' ? ['--offline'] : []), ...tasks];
  let stdout, stderr, exitCode;
  try {
    ({ stdout, stderr } = await runFile(java, args, { cwd: project, env: environment, windowsHide: true, encoding: 'utf8', timeout: 240000, maxBuffer: 4 * 1024 * 1024 }));
    exitCode = 0;
  } catch (error) {
    if (error.killed || typeof error.code !== 'number') throw error;
    stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; exitCode = error.code;
  }
  const log = join(evidence, `${name}.log`);
  await writeFile(log, `${stdout}\n${stderr}`);
  const diagnosis = await inspectAndroidProject({ projectDirectory: project, buildLogPath: log });
  const record = { name, tasks, exitCode, diagnosis };
  report.cases.push(record);
  await persist();
  return record;
}
try {
  const version = await runFile(java, ['-version'], { windowsHide: true, encoding: 'utf8' });
  report.javaVersion = `${version.stdout}${version.stderr}`.trim();
  const actualVersion = await runFile(java, ['-classpath', launcher, 'org.gradle.launcher.GradleMain', '--version'], { cwd: project, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  await writeFile(join(evidence, 'gradle-version.txt'), actualVersion.stdout);
  assert.match(actualVersion.stdout, /^Gradle 8\.13\s*$/m);
  const wrapper = await gradle('wrapper', ['wrapper', '--gradle-version=8.13', '--distribution-type=bin', '--no-validate-url']);
  assert.equal(wrapper.exitCode, 0, `Wrapper failed; inspect ${evidence}`);
  assert.equal(wrapper.diagnosis.wrapper.filesPresent, true);
  const success = await gradle('assemble-debug', [':app:assembleDebug']);
  assert.equal(success.exitCode, 0, `Build failed; inspect ${evidence}`);
  assert.equal(success.diagnosis.log.outcomeMarker, 'passed');
  assert.equal(success.diagnosis.identification, 'android-gradle-candidate');
  const apk = join(project, 'app/build/outputs/apk/debug/app-debug.apk');
  const bytes = await readFile(apk);
  assert(bytes.length > 0);
  report.apk = { path: apk, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const aapt = join(sdk, 'build-tools/35.0.0', process.platform === 'win32' ? 'aapt.exe' : 'aapt');
  const badging = await runFile(aapt, ['dump', 'badging', apk], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  await writeFile(join(evidence, 'apk-badging.txt'), badging.stdout);
  assert.match(badging.stdout, /package: name='dev\.appvanta\.buildprobe' versionCode='1' versionName='1'/);
  assert.match(badging.stdout, /launchable-activity: name='dev\.appvanta\.buildprobe\.MainActivity'/);
  const jar = join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
  const entries = await runFile(jar, ['tf', apk], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  await writeFile(join(evidence, 'apk-entries.txt'), entries.stdout);
  assert(entries.stdout.split(/\r?\n/).includes('classes.dex'));
  assert(entries.stdout.split(/\r?\n/).includes('AndroidManifest.xml'));
  const noSdk = { ...process.env };
  delete noSdk.ANDROID_HOME; delete noSdk.ANDROID_SDK_ROOT;
  const sdkFailure = await gradle('missing-sdk', [':app:assembleDebug'], noSdk);
  assert.notEqual(sdkFailure.exitCode, 0);
  assert(sdkFailure.diagnosis.log.findings.some(item => item.code === 'sdk-location'));
  const manifestPath = join(project, 'app/src/main/AndroidManifest.xml');
  await writeFile(manifestPath, source['app/src/main/AndroidManifest.xml'].replace('AppVanta Build Probe', '@string/appvanta_deliberately_missing'));
  const resourceFailure = await gradle('missing-resource', [':app:assembleDebug']);
  assert.notEqual(resourceFailure.exitCode, 0);
  assert(resourceFailure.diagnosis.log.findings.some(item => item.code === 'android-resources'));
  await writeFile(manifestPath, source['app/src/main/AndroidManifest.xml']);
  const dependencyFailure = await gradle('missing-dependency', [':app:assembleDebug', '-PmissingDependency=true', '--offline']);
  assert.notEqual(dependencyFailure.exitCode, 0);
  assert(dependencyFailure.diagnosis.log.findings.some(item => item.code === 'dependency-resolution'));
  for (const record of report.cases.filter(item => item.exitCode !== 0)) assert.equal(record.diagnosis.log.outcomeMarker, 'failed');
  const log = join(evidence, 'missing-sdk.log');
  const expected = await inspectAndroidProject({ projectDirectory: project, buildLogPath: log });
  const cli = await runFile(process.execPath, [join(root, 'packages/cli/dist/index.js'), 'inspect-project', project, log], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.deepEqual(JSON.parse(cli.stdout), expected);
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gradle-verifier', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/call', params: { name: 'inspect_android_project', arguments: { projectDirectory: project, buildLogPath: log } } },
  ];
  const response = await mcpExchange(messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })), [1, 2]);
  assert.equal(response.status, 0);
  assert.deepEqual(JSON.parse(response.stdout.split('\n').map(line => JSON.parse(line)).find(message => message.id === 2).result.content[0].text), expected);
  report.clients = ['sdk', 'cli', 'mcp'];
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); throw error;
} finally {
  await persist();
  console.log(JSON.stringify({ status: report.status, evidence }));
}
