import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runBuildProcess } from '../dist/build-process.js';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-build-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { cwd: root, logPath: join(root, 'process.log'), file: process.execPath, timeoutMs: 10000, cancellationGraceMs: 1000 };
}

test('process result preserves actual failure and exact bounded log bytes', async t => {
  const options = await fixture(t);
  const report = await runBuildProcess({ ...options, args: ['-e', 'process.stdout.write("failure details");process.exitCode=7'] });
  assert.equal(report.status, 'exited'); assert.equal(report.exitCode, 7);
  assert.equal(report.interruption, null); assert.equal(report.outputComplete, true);
  const log = await readFile(options.logPath);
  assert.equal(log.toString(), 'failure details');
  assert.equal(report.logSha256, createHash('sha256').update(log).digest('hex'));
  assert.equal(report.descendantCleanup, 'unverified');
});

test('deadline closes stdin first and retains timeout even when cooperative process exits zero', async t => {
  const options = await fixture(t);
  const report = await runBuildProcess({ ...options, timeoutMs: 800, args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("EOF acknowledged"))'] });
  assert.equal(report.status, 'exited'); assert.equal(report.exitCode, 0);
  assert.equal(report.interruption, 'timeout'); assert.equal(report.forced, false);
  assert.equal(await readFile(options.logPath, 'utf8'), 'EOF acknowledged');
});

test('output overflow is bounded on disk and asks cooperative process to cancel', async t => {
  const options = await fixture(t);
  const report = await runBuildProcess({ ...options, maxOutputBytes: 128, args: ['-e', 'process.stdout.write("x".repeat(8192));process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("cancelled"))'] });
  assert.equal(report.interruption, 'output-limit'); assert.equal(report.exitCode, 0);
  assert.equal(report.forced, false); assert.equal(report.logBytes, 128);
  assert.equal((await readFile(options.logPath)).length, 128);
  assert(report.receivedBytes > 128);
});

test('uncooperative process is force terminated after grace without claiming descendant cleanup', async t => {
  const options = await fixture(t);
  const report = await runBuildProcess({ ...options, timeoutMs: 500, cancellationGraceMs: 100, args: ['-e', 'setInterval(()=>{},1000)'] });
  assert.equal(report.interruption, 'timeout'); assert.equal(report.forced, true);
  assert.equal(report.status, 'exited'); assert.equal(report.signal, 'SIGKILL');
  assert.equal(report.descendantCleanup, 'unverified');
});

test('pre-aborted request never launches and missing executable has explicit launch failure', async t => {
  const first = await fixture(t);
  const skipped = await runBuildProcess({ ...first, args: ['-e', 'throw Error("must not launch")'], signal: AbortSignal.abort() });
  assert.equal(skipped.status, 'not-started'); assert.equal(skipped.pid, null); assert.equal(skipped.interruption, 'aborted');
  const second = await fixture(t);
  const failed = await runBuildProcess({ ...second, file: join(second.cwd, 'nonexistent-command'), args: [] });
  assert.equal(failed.status, 'launch-failed'); assert.equal(failed.errorCode, 'ENOENT');
});

test('live abort waits for EOF acknowledgment and keeps its interruption reason', async t => {
  const options = await fixture(t);
  const controller = new AbortController();
  const ready = join(options.cwd, 'ready');
  const pending = runBuildProcess({ ...options, signal: controller.signal, args: ['-e',
    'require("node:fs").writeFileSync(process.argv[1],"ready");process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("aborted cooperatively"))', ready] });
  const deadline = Date.now() + 5000;
  while (true) {
    try { if (await readFile(ready, 'utf8') === 'ready') break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(Date.now() < deadline, 'child never became ready'); await delay(20);
  }
  controller.abort();
  const report = await pending;
  assert.equal(report.interruption, 'aborted'); assert.equal(report.exitCode, 0);
  assert.equal(report.forced, false);
  assert.equal(await readFile(options.logPath, 'utf8'), 'aborted cooperatively');
});

test('a descendant holding the output pipe does not prevent a bounded return or imply complete output', async t => {
  const options = await fixture(t);
  const report = await runBuildProcess({ ...options, args: ['-e',
    'const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},4000)"],{cwd:require("node:os").tmpdir(),stdio:["ignore",1,2],detached:true});console.log(c.pid);c.unref();'] });
  const descendant = Number((await readFile(options.logPath, 'utf8')).trim());
  assert(Number.isInteger(descendant) && descendant > 0);
  try { process.kill(descendant, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 5000;
  while (true) {
    try { process.kill(descendant, 0); }
    catch (error) { if (error.code === 'ESRCH') break; throw error; }
    assert(Date.now() < deadline, 'fixture descendant did not exit'); await delay(20);
  }
  assert.equal(report.status, 'exited'); assert.equal(report.exitCode, 0);
  assert.equal(report.outputComplete, false); assert.equal(report.descendantCleanup, 'unverified');
});
