import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
        file('executing.json').text = groovy.json.JsonOutput.toJson([pid: ProcessHandle.current().pid(), phase: 'executing'])
        Thread.sleep(60000)
    }
}
tasks.register('childProcess', JavaExec) {
    classpath = files('../classes')
    mainClass = 'GradleExecChild'
    args file('child.json').absolutePath
    doFirst {
        file('executing.json').text = groovy.json.JsonOutput.toJson([pid: ProcessHandle.current().pid(), phase: 'executing'])
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
        project.file('executing.json').text = groovy.json.JsonOutput.toJson([pid: ProcessHandle.current().pid(), phase: 'executing'])
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
const child = spawn(java, ['-classpath', classes + delimiter + classpath, 'GradleCancellationProbe', installation.home, project, userHome, receipt, taskName], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '', spawnError;
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
child.on('error', error => { spawnError = error; });
const exited = () => child.exitCode !== null || child.signalCode !== null;
const report = { status: 'running', mode, evidence, project, userHome, installation, bridgePid: child.pid };
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
  report.task = await wait(async () => {
    assert(!exited(), `Bridge exited early; inspect ${join(evidence, 'stderr.log')}`);
    try { return JSON.parse(await readFile(join(project, 'executing.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
  }, 120000, 'actual Gradle task execution');
  assert(alive(report.task.pid));
  if (mode !== 'wait') {
    report.worker = await wait(async () => {
      assert(!exited(), `Bridge exited before ${mode} child; inspect ${join(evidence, 'stderr.log')}`);
      try { return JSON.parse(await readFile(join(project, 'child.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
    }, 30000, `${mode} child execution`);
    assert.notEqual(report.worker.pid, report.task.pid);
    assert.notEqual(report.worker.pid, child.pid);
    assert(alive(report.worker.pid));
  }
  const start = Date.now();
  child.stdin.end();
  await wait(exited, 20000, 'Tooling API cancellation');
  report.cancellationMs = Date.now() - start;
  report.bridge = JSON.parse(await readFile(receipt, 'utf8'));
  assert.equal(child.exitCode, 0);
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
  console.log(JSON.stringify({ status: report.status, evidence, cancellationMs: report.cancellationMs }));
}
