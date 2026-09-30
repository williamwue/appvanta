import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyEvidence } from '../packages/core/dist/archive.mjs';
import { analyzePerfetto } from '../packages/android/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const [sourceArgument, python, mode] = process.argv.slice(2); assert(sourceArgument && python, 'Specify controlled fixture trace and Perfetto Python executable');
assert(mode === undefined || mode === 'sampling-result' || mode === 'archive');
let source = sourceArgument, sourceArchive;
if (mode === 'archive') {
  const integrity = await verifyEvidence(sourceArgument);
  const manifest = JSON.parse(await readFile(join(sourceArgument, 'manifest.json'), 'utf8'));
  const candidates = manifest.files.filter(file => /^perfetto-sampling-[0-9]+\/verification\.json$/.test(file.path));
  assert.equal(candidates.length, 1, 'Expected exactly one controlled sampling run in archive');
  const evidence = JSON.parse(await readFile(join(sourceArgument, candidates[0].path), 'utf8'));
  assert.equal(evidence.status, 'passed'); assert.equal(evidence.scope, 'controlled-sampling-evidence');
  assert.equal(evidence.cohorts.length, 2);
  for (const cohort of evidence.cohorts) assert.equal(cohort.samples.length, 3);
  const sample = evidence.cohorts[0].samples[0];
  const name = sample.artifact.path.replaceAll('\\', '/').split('/').at(-1);
  assert(/^trace-[0-9a-f-]{36}\.perfetto-trace$/.test(name), 'Invalid sampled trace filename');
  const selected = `${candidates[0].path.split('/')[0]}/cohort-0-sample-0/${name}`;
  assert(manifest.files.some(file => file.path === selected), 'Sample missing from archive manifest');
  source = resolve(sourceArgument, selected);
  const digest = createHash('sha256').update(await readFile(source)).digest('hex');
  assert.equal(digest, sample.traceSha256);
  sourceArchive = { integrity, verification: candidates[0].path, selected, sha256: digest, expectedMetrics: sample.measurement.metrics };
}
if (mode === 'sampling-result') {
  const sampling = JSON.parse(await readFile(sourceArgument, 'utf8'));
  assert.equal(sampling.status, 'passed');
  const evidence = JSON.parse(await readFile(join(sampling.root, 'verification.json'), 'utf8'));
  assert.equal(evidence.scope, 'controlled-sampling-evidence');
  source = evidence.cohorts[0].samples[0].artifact.path;
}
const root = resolve('.appvanta/runs', `perfetto-cancellation-${Date.now()}`); await mkdir(root, { recursive: true });
if (sourceArchive) await writeFile(join(root, 'source-archive.json'), JSON.stringify(sourceArchive, null, 2));
const options = { trace: resolve(source), python, packageName: 'dev.appvanta.performanceprobe', windowMs: 6000 };
const normal = await analyzePerfetto(options);
assert.equal(JSON.parse(await readFile(join(normal.output, 'analysis.json'), 'utf8')).status, 'passed');
if (sourceArchive) assert.deepEqual(JSON.parse(await readFile(normal.metricsPath, 'utf8')).metrics, sourceArchive.expectedMetrics, 'Retained trace metrics must match the original device-run analysis');
const runnable = spawnSync(python, ['scripts/verify-perfetto-runnable.py', '--trace', resolve(source), '--package', options.packageName, '--output', join(root, 'runnable-evidence'), '--window-ms', String(options.windowMs)], { encoding: 'utf8', timeout: 120000 });
assert.equal(runnable.status, 0, runnable.stderr || String(runnable.error));
const pre = new AbortController(); pre.abort(new Error('Pre-cancelled'));
await assert.rejects(analyzePerfetto({ ...options, python: 'must-not-run', signal: pre.signal }), /Pre-cancelled/);
// Repeated packet bytes prolong real parser work; no metrics are asserted for this synthetic trace.
const large = join(root, 'cancellation-input.trace'), bytes = await readFile(source);
await writeFile(large, Buffer.concat(Array.from({ length: 256 }, () => bytes)));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function awaitProcessor(before, finished) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    for (const name of (await readdir('.appvanta/runs')).filter(name => name.startsWith('perfetto-analysis-') && !before.has(name))) {
      const directory = resolve('.appvanta/runs', name);
      let processor;
      try { processor = JSON.parse(await readFile(join(directory, 'processor.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
      if (processor.phase !== 'loading-trace') continue;
      assert(alive(processor.pid) && alive(processor.analysisPid), 'Both owned processes must be live before cancellation');
      return { directory, processor };
    }
    if (finished()) throw new Error('Analysis completed before cancellation checkpoint');
    await delay(5);
  }
  throw new Error('Processor startup checkpoint timed out');
}
const results = [];
for (const client of ['sdk', 'mcp', 'cli', 'owner-kill']) {
  const before = new Set(await readdir('.appvanta/runs'));
  let child, exited, active, completed = false, rpcOutput = '';
  const controller = new AbortController();
  const consoleRequest = join(root, 'cli-console.request');
  try {
    let pending;
    if (client === 'sdk') {
      pending = analyzePerfetto({ ...options, trace: large, signal: controller.signal }).then(value => ({ value }), error => ({ error: String(error) })).finally(() => { completed = true; });
    } else if (client === 'mcp') {
      child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      exited = once(child, 'exit'); child.stderr.resume(); child.stdout.on('data', data => { rpcOutput += data; });
      const initialized = readMcpResponses(child.stdout, [1]);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'perfetto-cancel-verifier', version: '1' } } }) + '\n'); await initialized;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'analyze_perfetto', arguments: { ...options, trace: large } } }) + '\n');
    } else if (client === 'owner-kill') {
      const script = `import {analyzePerfetto} from ${JSON.stringify(pathToFileURL(resolve('packages/android/dist/index.js')).href)}; await analyzePerfetto(JSON.parse(process.argv[1]));`;
      child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...options, trace: large })], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      exited = once(child, 'exit'); child.stdout.resume(); child.stderr.resume();
      pending = exited.then(([code, signal]) => ({ code, signal })).finally(() => { completed = true; });
    } else {
      const command = [process.execPath, 'packages/cli/dist/index.js', 'analyze-perfetto', large, options.packageName, python, '6000'];
      child = process.platform === 'win32'
        ? spawn(python, ['scripts/windows-console-runner.py', consoleRequest, ...command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      exited = once(child, 'exit'); child.stdout.resume(); let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      pending = exited.then(([code, signal]) => ({ code, signal, stderr })).finally(() => { completed = true; });
    }
    active = await awaitProcessor(before, () => completed);
    const started = Date.now();
    if (client === 'sdk') controller.abort(new Error('Verifier cancelled active analysis'));
    else if (client === 'mcp') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'Verifier cancelled active analysis' } }) + '\n');
    else if (client === 'owner-kill') assert(child.kill('SIGKILL'), 'SDK owner must still be live when terminated');
    else if (process.platform === 'win32') await writeFile(consoleRequest, 'cancel', { flag: 'wx' });
    else child.kill('SIGINT');
    const response = client === 'mcp' ? { cancelledResponseSuppressed: true } : await pending;
    if (client === 'sdk') assert.match(response.error, /cancellation requested/);
    if (client === 'cli') { assert.equal(response.code, 1); assert.match(response.stderr, /cancellation requested/); }
    if (client === 'cli' && process.platform === 'win32') {
      const consoleEvidence = JSON.parse(await readFile(`${consoleRequest}.json`, 'utf8'));
      assert.equal(consoleEvidence.sent, true); assert.equal(consoleEvidence.exited, true);
      assert.equal(consoleEvidence.exitCode, 1); assert.equal(consoleEvidence.event, 'CTRL_C_EVENT');
      assert.equal(alive(consoleEvidence.pid), false);
      response.consoleEvidence = consoleEvidence;
    }
    let analysis;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { analysis = JSON.parse(await readFile(join(active.directory, 'analysis.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if ((analysis || client === 'owner-kill') && !alive(active.processor.analysisPid) && !alive(active.processor.pid)) break;
      await delay(10);
    }
    if (client === 'owner-kill') {
      await writeFile(join(root, 'owner-death-observation.json'), JSON.stringify({ ownerPid: child.pid, ownerExit: response,
        processor: active.processor, elapsedMs: Date.now() - started, analysis: analysis ?? null,
        analysisAlive: alive(active.processor.analysisPid), processorAlive: alive(active.processor.pid) }, null, 2));
      assert(response.signal === 'SIGKILL' || response.code !== 0, 'Owner must not exit successfully');
      assert(Date.now() - started < 5000, 'Owner death cleanup exceeded five seconds');
      assert.notEqual(analysis?.status, 'passed', 'Killed owner must not leave successful analysis');
    } else {
      assert(analysis, 'Cancellation evidence missing');
      assert.equal(analysis.status, 'cancelled');
      assert.equal(analysis.cancellation.processorExited, true); assert.equal(analysis.cancellation.cleanupError, null);
    }
    assert.equal(alive(active.processor.pid), false); assert.equal(alive(active.processor.analysisPid), false);
    await assert.rejects(access(join(active.directory, 'metrics.json')));
    await assert.rejects(access(join(active.directory, 'report.md')));
    if (client === 'mcp') {
      const listed = readMcpResponses(child.stdout, [3]);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) + '\n');
      assert((await listed)[0].result.tools.length > 0);
      assert(!rpcOutput.trim().split('\n').map(JSON.parse).some(message => message.id === 2));
    }
    results.push({ client, ...active, elapsedMs: Date.now() - started, analysis: analysis ?? null, response,
      ...(client === 'owner-kill' ? { scope: 'External observation after SDK owner hard termination; not a cooperative cancellation receipt', analysisExited: true, processorExited: true, successArtifactsAbsent: true } : {}) });
  } finally {
    controller.abort(new Error('Verifier teardown'));
    if (client === 'owner-kill' && active && alive(active.processor.analysisPid)) {
      await writeFile(`${active.directory}.cancel`, JSON.stringify({ fixtureCleanup: true }), { flag: 'wx' });
      const deadline = Date.now() + 5000;
      while (alive(active.processor.analysisPid) && Date.now() < deadline) await delay(25);
      await writeFile(join(root, 'owner-death-fixture-cleanup.json'), JSON.stringify({ analysisAlive: alive(active.processor.analysisPid), processorAlive: alive(active.processor.pid) }));
    }
    if (child) { child.kill(); await exited; }
    await writeFile(join(root, 'progress.json'), JSON.stringify(results, null, 2));
  }
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', normal, results, cliSignalVerified: true, cliSignal: process.platform === 'win32' ? 'CTRL_C_EVENT' : 'SIGINT' }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
