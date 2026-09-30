import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
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
for (const client of ['sdk', 'mcp', ...(process.platform === 'win32' ? [] : ['cli'])]) {
  const before = new Set(await readdir('.appvanta/runs'));
  let child, exited, completed = false, rpcOutput = '';
  const controller = new AbortController();
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
    } else {
      child = spawn(process.execPath, ['packages/cli/dist/index.js', 'analyze-perfetto', large, options.packageName, python, '6000'], { stdio: ['ignore', 'pipe', 'pipe'] });
      exited = once(child, 'exit'); child.stdout.resume(); let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      pending = exited.then(([code, signal]) => ({ code, signal, stderr })).finally(() => { completed = true; });
    }
    const active = await awaitProcessor(before, () => completed);
    const started = Date.now();
    if (client === 'sdk') controller.abort(new Error('Verifier cancelled active analysis'));
    else if (client === 'mcp') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'Verifier cancelled active analysis' } }) + '\n');
    else child.kill('SIGINT');
    const response = client === 'mcp' ? { cancelledResponseSuppressed: true } : await pending;
    if (client === 'sdk') assert.match(response.error, /cancellation requested/);
    if (client === 'cli') { assert.equal(response.code, 1); assert.match(response.stderr, /cancellation requested/); }
    let analysis;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { analysis = JSON.parse(await readFile(join(active.directory, 'analysis.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (analysis && !alive(active.processor.analysisPid)) break;
      await delay(10);
    }
    assert(analysis, 'Cancellation evidence missing');
    assert.equal(analysis.status, 'cancelled');
    assert.equal(analysis.cancellation.processorExited, true); assert.equal(analysis.cancellation.cleanupError, null);
    assert.equal(alive(active.processor.pid), false); assert.equal(alive(active.processor.analysisPid), false);
    await assert.rejects(access(join(active.directory, 'metrics.json')));
    await assert.rejects(access(join(active.directory, 'report.md')));
    if (client === 'mcp') {
      const listed = readMcpResponses(child.stdout, [3]);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) + '\n');
      assert((await listed)[0].result.tools.length > 0);
      assert(!rpcOutput.trim().split('\n').map(JSON.parse).some(message => message.id === 2));
    }
    results.push({ client, ...active, elapsedMs: Date.now() - started, analysis, response });
  } finally {
    controller.abort(new Error('Verifier teardown'));
    if (child) { child.kill(); await exited; }
    await writeFile(join(root, 'progress.json'), JSON.stringify(results, null, 2));
  }
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', normal, results, cliSignalVerified: process.platform !== 'win32' }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
