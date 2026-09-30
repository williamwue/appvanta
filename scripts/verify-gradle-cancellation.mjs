import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveGradleInstallation } from './gradle-installation.mjs';
import { runLoggedCommand } from './logged-command.mjs';
import { createHash } from 'node:crypto';
import { acquireBuildProject } from '../packages/android/dist/build-ownership.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installation = resolveGradleInstallation(process.argv[2]);
const mode = process.env.APPVANTA_GRADLE_CANCEL_TASK ?? 'wait';
if (!['wait', 'javaexec', 'worker', 'success', 'failure'].includes(mode)) throw new Error('Invalid APPVANTA_GRADLE_CANCEL_TASK');
const trigger = process.env.APPVANTA_GRADLE_CANCEL_TRIGGER ?? 'eof';
if (!['eof', 'bridge-kill', 'owner-kill', 'complete'].includes(trigger)) throw new Error('Invalid APPVANTA_GRADLE_CANCEL_TRIGGER');
if (['success', 'failure'].includes(mode) !== (trigger === 'complete')) throw new Error('success/failure tasks require the complete trigger');
if (!process.env.JAVA_HOME) throw new Error('JAVA_HOME is required');
const java = join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const javac = join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
const id = `gradle-cancellation-${Date.now()}`;
const working = join(root, '.appvanta/gradle-projects', id);
const project = join(working, 'project'), userHome = join(working, 'gradle-home');
const evidence = join(root, '.appvanta/runs', id), classes = join(working, 'classes');
await mkdir(project, { recursive: true });
await mkdir(classes, { recursive: true });
await mkdir(evidence, { recursive: true });
await writeFile(join(project, 'settings.gradle'), "rootProject.name = 'AppVantaCancellationProbe'\n");
await writeFile(join(project, 'build.gradle'), `tasks.register('waitForCancellation') {
    doLast {
        file('executing.json').text = groovy.json.JsonOutput.toJson([pid: ProcessHandle.current().pid(), phase: 'executing', userHome: gradle.gradleUserHomeDir.absolutePath])
        Thread.sleep(60000)
    }
}
tasks.register('childProcess', JavaExec) {
    classpath = files('../classes')
    mainClass = 'GradleExecChild'
    args file('child.json').absolutePath
    doFirst {
        file('executing.json').text = groovy.json.JsonOutput.toJson([pid: ProcessHandle.current().pid(), phase: 'executing', userHome: gradle.gradleUserHomeDir.absolutePath])
    }
}
interface ProbeParameters extends org.gradle.workers.WorkParameters {
    org.gradle.api.file.RegularFileProperty getReceipt()
}
abstract class ProbeAction implements org.gradle.workers.WorkAction<ProbeParameters> {
    void execute() {
        parameters.receipt.get().asFile.text = groovy.json.JsonOutput.toJson([pid: ProcessHandle.current().pid(), phase: 'executing'])
        Thread.sleep(60000)
    }
}
abstract class ProbeTask extends DefaultTask {
    @javax.inject.Inject
    abstract org.gradle.workers.WorkerExecutor getWorkerExecutor()
    @TaskAction
    void runProbe() {
        project.file('executing.json').text = groovy.json.JsonOutput.toJson([pid: ProcessHandle.current().pid(), phase: 'executing', userHome: project.gradle.gradleUserHomeDir.absolutePath])
        def destination = project.layout.projectDirectory.file('child.json')
        workerExecutor.processIsolation().submit(ProbeAction) { parameters ->
            parameters.receipt.set(destination)
        }
        workerExecutor.await()
    }
}
tasks.register('isolatedWorker', ProbeTask)
tasks.register('controlledCompletion') {
    doLast {
        file('executing.json').text = groovy.json.JsonOutput.toJson([pid: ProcessHandle.current().pid(), phase: 'executing', userHome: gradle.gradleUserHomeDir.absolutePath])
        def deadline = System.nanoTime() + 60000000000L
        while (!file('complete.signal').exists()) {
            if (System.nanoTime() > deadline) throw new GradleException('Completion handshake timed out')
            Thread.sleep(25)
        }
        if (file('complete.signal').text == 'failure') throw new GradleException('APPVANTA_EXPECTED_TASK_FAILURE')
        file('task-result.txt').text = 'APPVANTA_EXPECTED_TASK_SUCCESS'
    }
}
tasks.register('verifyArguments') {
    doLast { file('argument.txt').text = providers.gradleProperty('bridgeValue').get() }
}
`);
const classpath = join(installation.home, 'lib', '*');
const bridgeSource = join(root, 'packages/android/dist/runtime/GradleBuildBridge.java');
const bridgeSourceSha256 = createHash('sha256').update(await readFile(bridgeSource)).digest('hex');
await promisify(execFile)(javac, ['-classpath', classpath, '-d', classes, bridgeSource, join(root, 'scripts/fixtures/GradleExecChild.java')], { windowsHide: true, timeout: 30000 });
const receipt = join(evidence, 'bridge.json');
const taskName = { wait: 'waitForCancellation', javaexec: 'childProcess', worker: 'isolatedWorker', success: 'controlledCompletion', failure: 'controlledCompletion' }[mode];
const tasks = mode === 'success' ? [taskName, 'verifyArguments'] : [taskName];
const propertyValue = 'space 中文 ; & = literal';
const bridgeArgs = ['-classpath', classes + delimiter + classpath, 'GradleBuildBridge', installation.home, project, userHome, receipt, String(tasks.length), ...tasks, '--offline', '--console=plain', '--max-workers=1', `-PbridgeValue=${propertyValue}`];
const ownershipPath = join(evidence, 'owner.json');
const projectOwnership = await acquireBuildProject(project);
await assert.rejects(acquireBuildProject(project), { code: 'BUILD_PROJECT_BUSY' });
const child = trigger === 'owner-kill'
  ? spawn(process.execPath, [join(root, 'scripts/fixtures/gradle-bridge-owner.mjs'), ownershipPath, java, ...bridgeArgs], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn(java, bridgeArgs, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '', spawnError;
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
child.on('error', error => { spawnError = error; });
const exited = () => child.exitCode !== null || child.signalCode !== null;
const report = { status: 'running', mode, trigger, evidence, project, userHome, installation, bridgeSourceSha256, projectOwner: projectOwnership.owner, ...(trigger === 'owner-kill' ? { ownerPid: child.pid } : { bridgePid: child.pid }) };
const wait = async (test, ms, description) => {
  const deadline = Date.now() + ms;
  do {
    if (spawnError) throw spawnError;
    const value = await test();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
try {
  if (trigger === 'owner-kill') {
    report.ownership = await wait(async () => {
      assert(!exited(), 'Owner exited before publishing bridge ownership');
      try { return JSON.parse(await readFile(ownershipPath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
    }, 10000, 'Node owner bridge handshake');
    assert.equal(report.ownership.ownerPid, child.pid);
    assert.equal(report.ownership.parentPid, process.pid);
    assert.equal(report.ownership.bridgeDetached, true);
    report.bridgePid = report.ownership.bridgePid;
    assert.notEqual(report.bridgePid, child.pid);
    assert(alive(report.bridgePid));
  }
  report.task = await wait(async () => {
    assert(!exited(), `Bridge exited early; inspect ${join(evidence, 'stderr.log')}`);
    try { return JSON.parse(await readFile(join(project, 'executing.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
  }, 120000, 'actual Gradle task execution');
  assert(alive(report.task.pid));
  assert.equal(await realpath(report.task.userHome), await realpath(userHome));
  if (['javaexec', 'worker'].includes(mode)) {
    report.worker = await wait(async () => {
      assert(!exited(), `Bridge exited before ${mode} child; inspect ${join(evidence, 'stderr.log')}`);
      try { return JSON.parse(await readFile(join(project, 'child.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
    }, 30000, `${mode} child execution`);
    assert.notEqual(report.worker.pid, report.task.pid);
    assert.notEqual(report.worker.pid, child.pid);
    assert.notEqual(report.worker.pid, report.bridgePid);
    assert(alive(report.worker.pid));
  }
  await writeFile(join(evidence, 'before-interruption.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  const start = Date.now();
  if (trigger === 'complete') {
    await writeFile(join(project, 'complete.signal'), mode, { flag: 'wx' });
    await wait(exited, 20000, 'Tooling API terminal result');
    assert.equal(child.exitCode, 0);
    report.completionMs = Date.now() - start;
    report.bridge = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(report.bridge.status, mode === 'success' ? 'passed' : 'failed');
    assert.equal(report.bridge.cancellationRequested, false);
    assert.equal(report.bridge.failureClass, mode === 'success' ? '' : 'org.gradle.tooling.BuildException');
    if (mode === 'success') {
      assert.equal(await readFile(join(project, 'task-result.txt'), 'utf8'), 'APPVANTA_EXPECTED_TASK_SUCCESS');
      assert.equal(await readFile(join(project, 'argument.txt'), 'utf8'), propertyValue);
      report.argumentRoundTrip = true;
    }
    else assert.match(stderr, /APPVANTA_EXPECTED_TASK_FAILURE/);
    report.daemonAliveAfterCompletion = alive(report.task.pid);
  } else if (trigger !== 'bridge-kill') {
    if (trigger === 'owner-kill') {
      assert(child.kill('SIGKILL'), 'Owned Node force termination was not delivered');
      await wait(exited, 10000, 'Node owner exit');
      assert.equal(child.signalCode, 'SIGKILL');
      report.ownerExit = { code: child.exitCode, signal: child.signalCode, elapsedMs: Date.now() - start };
      await wait(() => !alive(report.bridgePid), 20000, 'Java bridge cancellation after Node owner death');
      report.bridgeExited = true;
    } else {
      child.stdin.end();
      await wait(exited, 20000, 'Tooling API cancellation');
      assert.equal(child.exitCode, 0);
    }
    report.cancellationMs = Date.now() - start;
    report.bridge = JSON.parse(await readFile(receipt, 'utf8'));
    assert.equal(report.bridge.status, 'cancelled');
    assert.equal(report.bridge.cancellationRequested, true);
    assert.equal(report.bridge.failureClass, 'org.gradle.tooling.BuildCancelledException');
    if (report.worker) {
      report.workerAliveAfterCancellation = alive(report.worker.pid);
      if (mode === 'javaexec') {
        await wait(() => !alive(report.worker.pid), 10000, 'JavaExec child exit before daemon stop');
        report.workerExitedBeforeStop = true;
      }
    }
    report.daemonAliveAfterCancellation = alive(report.task.pid);
  } else {
    assert(child.kill('SIGKILL'), 'Owned bridge force termination was not delivered');
    await wait(exited, 10000, 'forced bridge exit');
    report.bridgeExit = { code: child.exitCode, signal: child.signalCode, elapsedMs: Date.now() - start };
    assert.notEqual(child.exitCode, 0);
    assert.equal(child.signalCode, 'SIGKILL');
    await assert.rejects(readFile(receipt, 'utf8'), error => error.code === 'ENOENT');
    report.bridgeReceiptMissing = true;
    await delay(500);
    report.afterBridgeKill = { elapsedMs: Date.now() - start, daemonAlive: alive(report.task.pid), ...(report.worker ? { workerAlive: alive(report.worker.pid) } : {}) };
  }
  if (report.bridge) {
    assert.equal(report.bridge.version, 1);
    assert.equal(report.bridge.bridgePid, report.bridgePid);
    assert.equal(report.bridge.taskCount, tasks.length);
  }
  await writeFile(join(evidence, 'before-stop.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  const stopped = await runLoggedCommand({ file: java, args: ['-classpath', installation.launcher, 'org.gradle.launcher.GradleMain', '--stop', '--gradle-user-home', userHome], cwd: project, logPath: join(evidence, 'stop.log'), timeoutMs: 30000 });
  report.stop = stopped;
  assert.equal(stopped.status, 'exited');
  assert.equal(stopped.exitCode, 0);
  await wait(() => !alive(report.task.pid), 10000, 'isolated Gradle daemon exit');
  report.daemonExited = true;
  if (mode === 'success') {
    const original = await readFile(receipt, 'utf8');
    const repeated = await runLoggedCommand({ file: java, args: bridgeArgs, cwd: root, logPath: join(evidence, 'repeat-receipt.log'), timeoutMs: 30000 });
    assert.equal(repeated.status, 'exited');
    assert.notEqual(repeated.exitCode, 0);
    assert.match(await readFile(join(evidence, 'repeat-receipt.log'), 'utf8'), /Receipt already exists/);
    assert.equal(await readFile(receipt, 'utf8'), original);
    assert.equal(alive(report.task.pid), false);
    report.repeatedReceiptRejected = true;
  }
  if (report.worker) {
    await wait(() => !alive(report.worker.pid), 10000, `${mode} child exit after daemon stop`);
    report.workerExitedAfterStop = true;
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error); throw error;
} finally {
  if (!exited()) {
    child.stdin.end();
    try { await wait(exited, 10000, 'bridge failure cleanup'); }
    catch {
      child.kill();
      try { await wait(exited, 5000, 'owned bridge exit'); }
      catch (error) { report.bridgeCleanupError = String(error); }
    }
  }
  if (report.status !== 'passed') {
    try { report.fallbackStop = await runLoggedCommand({ file: java, args: ['-classpath', installation.launcher, 'org.gradle.launcher.GradleMain', '--stop', '--gradle-user-home', userHome], cwd: project, logPath: join(evidence, 'fallback-stop.log'), timeoutMs: 30000 }); }
    catch (error) { report.daemonCleanupError = String(error); }
  }
  await writeFile(join(evidence, 'stdout.log'), stdout);
  await writeFile(join(evidence, 'stderr.log'), stderr);
  try {
    report.projectOwnership = await projectOwnership.finish({
      execution: report.status === 'passed' ? ({ passed: 'succeeded', failed: 'failed', cancelled: 'cancelled' }[report.bridge?.status] ?? 'unknown') : 'unknown',
      cleanup: report.daemonExited && (!report.worker || report.workerExitedAfterStop) ? 'verified' : 'unverified',
    });
    await writeFile(join(evidence, 'project-outcome.json'), await readFile(join(report.projectOwnership.recordDirectory, 'outcome.json')));
    assert.equal(report.projectOwnership.released, report.status === 'passed' && trigger !== 'bridge-kill');
    if (!report.projectOwnership.released) await assert.rejects(acquireBuildProject(project), { code: 'BUILD_PROJECT_BUSY' });
  } catch (error) {
    report.status = 'failed'; report.projectOwnershipError = String(error); process.exitCode = 1;
  }
  await writeFile(join(evidence, 'verification.json'), JSON.stringify(report, null, 2));
  child.stdout.destroy();
  child.stderr.destroy();
  console.log(JSON.stringify({ status: report.status, evidence, cancellationMs: report.cancellationMs }));
}
