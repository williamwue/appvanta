import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveGradleInstallation } from './gradle-installation.mjs';
import { runLoggedCommand } from './logged-command.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installation = resolveGradleInstallation(process.argv[2]);
const mode = process.env.APPVANTA_GRADLE_CANCEL_TASK ?? 'wait';
if (!['wait', 'javaexec', 'worker'].includes(mode)) throw new Error('APPVANTA_GRADLE_CANCEL_TASK must be wait, javaexec or worker');
const trigger = process.env.APPVANTA_GRADLE_CANCEL_TRIGGER ?? 'eof';
if (!['eof', 'bridge-kill', 'owner-kill'].includes(trigger)) throw new Error('APPVANTA_GRADLE_CANCEL_TRIGGER must be eof, bridge-kill or owner-kill');
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
`);
const classpath = join(installation.home, 'lib', '*');
await promisify(execFile)(javac, ['-classpath', classpath, '-d', classes, join(root, 'scripts/fixtures/GradleCancellationProbe.java'), join(root, 'scripts/fixtures/GradleExecChild.java')], { windowsHide: true, timeout: 30000 });
const receipt = join(evidence, 'bridge.json');
const taskName = { wait: 'waitForCancellation', javaexec: 'childProcess', worker: 'isolatedWorker' }[mode];
const bridgeArgs = ['-classpath', classes + delimiter + classpath, 'GradleCancellationProbe', installation.home, project, userHome, receipt, taskName];
const ownershipPath = join(evidence, 'owner.json');
const child = trigger === 'owner-kill'
  ? spawn(process.execPath, [join(root, 'scripts/fixtures/gradle-bridge-owner.mjs'), ownershipPath, java, ...bridgeArgs], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn(java, bridgeArgs, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '', spawnError;
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
child.on('error', error => { spawnError = error; });
const exited = () => child.exitCode !== null || child.signalCode !== null;
const report = { status: 'running', mode, trigger, evidence, project, userHome, installation, ...(trigger === 'owner-kill' ? { ownerPid: child.pid } : { bridgePid: child.pid }) };
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
  if (mode !== 'wait') {
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
  if (trigger !== 'bridge-kill') {
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
  await writeFile(join(evidence, 'before-stop.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  const stopped = await runLoggedCommand({ file: java, args: ['-classpath', installation.launcher, 'org.gradle.launcher.GradleMain', '--stop', '--gradle-user-home', userHome], cwd: project, logPath: join(evidence, 'stop.log'), timeoutMs: 30000 });
  report.stop = stopped;
  assert.equal(stopped.status, 'exited');
  assert.equal(stopped.exitCode, 0);
  await wait(() => !alive(report.task.pid), 10000, 'isolated Gradle daemon exit');
  report.daemonExited = true;
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
  await writeFile(join(evidence, 'verification.json'), JSON.stringify(report, null, 2));
  child.stdout.destroy();
  child.stderr.destroy();
  console.log(JSON.stringify({ status: report.status, evidence, cancellationMs: report.cancellationMs }));
}
