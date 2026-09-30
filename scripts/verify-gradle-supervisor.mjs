import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireBuildProject } from '../packages/android/dist/build-ownership.js';
import { runBuildProcess } from '../packages/android/dist/build-process.js';
import { writeGradleBridgeRequest } from '../packages/android/dist/build-request.js';
import { resolveGradleInstallation } from './gradle-installation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installation = resolveGradleInstallation(process.argv[2]);
const mode = process.env.APPVANTA_GRADLE_SUPERVISOR_MODE ?? 'cancel';
assert(['cancel', 'configuration-failure'].includes(mode), 'Invalid supervisor mode');
assert(process.env.JAVA_HOME, 'JAVA_HOME is required');
const binary = name => join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const id = `gradle-supervisor-${Date.now()}`;
const work = join(root, '.appvanta/gradle-projects', id);
const project = join(work, 'project'), classes = join(work, 'classes'), userHome = join(work, 'gradle-home');
const evidence = join(root, '.appvanta/runs', id);
for (const directory of [project, classes, evidence]) await mkdir(directory, { recursive: true });
await writeFile(join(project, 'settings.gradle'), "rootProject.name = 'AppVantaSupervisor'\n" +
  (mode === 'configuration-failure' ? "throw new GradleException('APPVANTA_EXPECTED_CONFIGURATION_FAILURE')\n" : ''));
await writeFile(join(project, 'build.gradle'), `tasks.register('waitForOwner') {
  doLast {
    file('executing.txt').text = 'executing'
    Thread.sleep(60000)
  }
}\n`);
const checked = result => {
  assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0);
  assert.equal(result.interruption, null); assert.equal(result.logError, null); assert.equal(result.outputComplete, true);
};
const classpath = join(installation.home, 'lib', '*');
checked(await runBuildProcess({ file: binary('javac'), args: ['-classpath', classpath, '-d', classes,
  join(root, 'packages/android/dist/runtime/GradleBuildBridge.java')], cwd: root, logPath: join(evidence, 'compile.log'), timeoutMs: 30000 }));
const ownership = await acquireBuildProject(project);
const controller = new AbortController();
const report = { status: 'running', mode, project, userHome, installation, owner: ownership.owner };
const receipt = join(evidence, 'bridge.json');
const request = await writeGradleBridgeRequest(join(evidence, 'bridge.request'), { installation: installation.home, project, userHome, receipt,
  tasks: ['waitForOwner'], arguments: ['--offline', '--console=plain', '--max-workers=1'] });
report.requestSha256 = request.requestSha256;
const execution = runBuildProcess({ file: binary('java'), args: ['-classpath', classes + delimiter + classpath,
  'GradleBuildBridge', ...request.launcherArguments],
  cwd: project, logPath: join(evidence, 'build.log'), timeoutMs: 150000, cancellationGraceMs: 20000, signal: controller.signal });
let terminal;
void execution.then(result => { terminal = result; }, error => { terminal = { error: String(error) }; });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const stop = () => runBuildProcess({ file: binary('java'), args: ['-classpath', installation.launcher, 'org.gradle.launcher.GradleMain',
  '--stop', '--gradle-user-home', userHome], cwd: project, logPath: join(evidence, report.stop ? 'fallback-stop.log' : 'stop.log'), timeoutMs: 30000 });
try {
  const deadline = Date.now() + 120000;
  let executing = false;
  while (mode === 'cancel' && !executing) {
    assert(!terminal, 'Bridge completed before task handshake');
    try { executing = await readFile(join(project, 'executing.txt'), 'utf8') === 'executing'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(Date.now() < deadline, 'Task handshake timed out');
    if (!executing) await delay(50);
  }
  if (mode === 'configuration-failure') report.process = await execution;
  const daemonFiles = await readdir(receipt + '.daemons');
  assert.equal(daemonFiles.length, 1);
  report.task = JSON.parse(await readFile(join(receipt + '.daemons', daemonFiles[0]), 'utf8'));
  assert(Number.isSafeInteger(report.task.startEpochMillis) && report.task.startEpochMillis > 0);
  assert(alive(report.task.pid));
  assert.equal(await realpath(report.task.userHome), await realpath(userHome));
  await writeFile(join(evidence, 'before-abort.json'), JSON.stringify(report, null, 2));
  if (mode === 'cancel') controller.abort();
  report.process = await execution;
  assert.equal(report.process.status, 'exited'); assert.equal(report.process.exitCode, 0);
  assert.equal(report.process.interruption, mode === 'cancel' ? 'aborted' : null); assert.equal(report.process.forced, false);
  assert.equal(report.process.outputComplete, true); assert.equal(report.process.logError, null);
  report.bridge = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(report.bridge.status, mode === 'cancel' ? 'cancelled' : 'failed');
  assert.equal(report.bridge.failureClass, mode === 'cancel' ? 'org.gradle.tooling.BuildCancelledException' : 'org.gradle.tooling.BuildException');
  if (mode === 'configuration-failure') {
    assert.match(await readFile(join(evidence, 'build.log'), 'utf8'), /APPVANTA_EXPECTED_CONFIGURATION_FAILURE/);
    await assert.rejects(readFile(join(project, 'executing.txt')), { code: 'ENOENT' });
  }
  assert.equal(report.bridge.bridgePid, report.process.pid);
  assert.equal(report.bridge.invocation, report.task.invocation);
  report.stop = await stop(); checked(report.stop);
  const stopDeadline = Date.now() + 10000;
  while (alive(report.task.pid)) { assert(Date.now() < stopDeadline, 'Daemon did not exit'); await delay(50); }
  report.daemonExited = true;
  report.ownership = await ownership.finish({ execution: mode === 'cancel' ? 'cancelled' : 'failed', cleanup: 'verified' });
  assert.equal(report.ownership.released, true);
  report.status = 'passed';
} catch (error) {
  report.error = String(error); report.status = 'failed'; process.exitCode = 1;
  controller.abort();
  try { report.process = await execution; } catch (failure) { report.processError = String(failure); }
  try { report.fallbackStop = await stop(); } catch (failure) { report.stopError = String(failure); }
} finally {
  await writeFile(join(evidence, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, evidence }));
}
