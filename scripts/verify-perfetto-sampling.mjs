import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeviceLock, inspectDeviceLock, parsePerformanceDocument, checkPerformanceBaseline } from '../packages/core/dist/index.js';
import { analyzePerfetto } from '../packages/android/dist/index.js';
import { captureArtifact } from '../packages/android/dist/capture.js';
import { observeAdbTransport } from './adb-transport-observer.mjs';

const [device, python] = process.argv.slice(2); assert(device && python, 'Specify device and Perfetto Python executable');
const root = resolve('.appvanta/runs', `perfetto-sampling-${Date.now()}`); await mkdir(root, { recursive: true });
const pkg = 'dev.appvanta.performanceprobe', iterations = 5000000, warmups = 2, count = 3, windowMs = 6000;
const apk = resolve('.appvanta/performance-probe/appvanta-performance-probe.apk');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const apkSha256 = sha(await readFile(apk));
const scenario = `xorshift32-v1-${iterations}-${apkSha256}`;
let expected = 0x12345678;
for (let i = 0; i < iterations; i++) { expected ^= expected << 13; expected ^= expected >>> 17; expected ^= expected << 5; }
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', device, ...args], { windowsHide: true, encoding: 'utf8', timeout: 20000 })).stdout;
const results = [], cohorts = [];
let transportObserver;
async function workload() {
  const id = randomUUID();
  await adb('shell', 'am', 'start', '-W', '-n', `${pkg}/.PerformanceActivity`, '--es', 'runId', id, '--ei', 'iterations', String(iterations));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    let raw;
    try {
      await adb('shell', 'run-as', pkg, 'test', '-f', `files/result-${id}.json`);
      raw = await adb('exec-out', 'run-as', pkg, 'cat', `files/result-${id}.json`);
    }
    catch { await delay(100); continue; }
    const receipt = JSON.parse(raw);
    assert.equal(receipt.runId, id); assert.equal(receipt.iterations, iterations); assert.equal(receipt.checksum, String(expected >>> 0));
    assert(receipt.endElapsedNs > receipt.startElapsedNs && receipt.threadCpuNs > 0);
    await writeFile(join(root, `workload-${id}.json`), raw);
    results.push(receipt);
    return receipt;
  }
  throw new Error(`Workload receipt timeout: ${id}`);
}
try {
  await withDeviceLock(device, async () => {
    transportObserver = await observeAdbTransport(device, root, process.env.ADB_PATH ?? 'adb');
    await adb('install', '-r', apk);
    for (let cohort = 0; cohort < 2; cohort++) {
      await adb('shell', 'am', 'force-stop', pkg);
      const warmupReceipts = [];
      for (let i = 0; i < warmups; i++) warmupReceipts.push(await workload());
      const samples = [];
      for (let i = 0; i < count; i++) {
        const directory = join(root, `cohort-${cohort}-sample-${i}`);
        let ready;
        const started = new Promise(done => { ready = done; });
        const capture = captureArtifact(process.env.ADB_PATH ?? 'adb', device, directory, 'trace', 8, undefined, { ready, stop: new AbortController().signal, allowNaturalEnd: true });
        let receipt, artifact;
        const token = randomUUID(), markers = [];
        const mark = async phase => {
          const marker = `AppVanta:${token}:1:${phase}`;
          await adb('shell', `printf 'C|%s|${marker}|1\\n' $$ > /sys/kernel/tracing/trace_marker`);
          markers.push({ index: 1, phase, marker });
          await writeFile(join(directory, 'step-markers.json'), JSON.stringify({ version: 1, token, markers }));
        };
        try {
          await Promise.race([started, capture.then(() => { throw new Error('Capture ended before readiness'); })]);
          await delay(1000);
          await mark('begin'); receipt = await workload(); await mark('end');
        }
        finally { artifact = await capture; }
        const analysisResult = await analyzePerfetto({ trace: artifact.path, packageName: pkg, python, scenario, windowMs });
        const measurement = parsePerformanceDocument(JSON.parse(await readFile(analysisResult.metricsPath, 'utf8')), 'measurement');
        const analysis = JSON.parse(await readFile(join(analysisResult.output, 'analysis.json'), 'utf8'));
        assert.equal(analysis.traceSha256, sha(await readFile(artifact.path)));
        assert.equal(analysis.window.durationMs, windowMs);
        assert(measurement.metrics['cpu.scheduledTime'].value > 0);
        assert(analysis.threads.some(thread => thread.pid === receipt.pid && thread.tid === receipt.tid && thread.scheduled_ns > 0));
        assert.equal(analysis.steps.length, 1);
        assert(analysis.steps[0].startNs >= analysis.window.startNs && analysis.steps[0].endNs <= analysis.window.endNs, 'Complete workload must be inside fixed analysis window');
        const sample = { receipt, artifact, analysisResult, traceSha256: analysis.traceSha256, measurement };
        samples.push(sample);
        await writeFile(join(directory, 'sample.json'), JSON.stringify(sample, null, 2));
      }
      const context = samples[0].measurement.context;
      for (const sample of samples) assert.deepEqual(sample.measurement.context, context);
      const metrics = Object.fromEntries(Object.entries(samples[0].measurement.metrics).map(([name, metric]) => {
        const values = samples.map(sample => sample.measurement.metrics[name].value).sort((a, b) => a - b);
        return [name, { unit: metric.unit, value: values[1] }];
      }));
      const measurement = parsePerformanceDocument({ version: 2, kind: 'measurement', context: { ...context, sampling: { durationMs: windowMs, iterations: count, warmupIterations: warmups, aggregation: 'median' } }, metrics }, 'measurement');
      cohorts.push({ warmupReceipts, samples, measurement });
    }
    await adb('shell', 'am', 'force-stop', pkg);
    for (const receipt of results) await adb('shell', 'run-as', pkg, 'rm', '-f', `files/result-${receipt.runId}.json`);
  });
  assert.equal(new Set(cohorts.flatMap(cohort => cohort.samples.map(sample => sample.traceSha256))).size, count * 2);
  const baseline = { ...cohorts[0].measurement, kind: 'baseline', metrics: Object.fromEntries(Object.entries(cohorts[0].measurement.metrics).map(([name, metric]) => [name, { unit: metric.unit, max: metric.value * 1.25 }])) };
  // A measured regression remains a reported regression, never a reason to widen the threshold.
  const comparison = checkPerformanceBaseline(baseline, cohorts[1].measurement);
  await writeFile(join(root, 'baseline.json'), JSON.stringify(baseline, null, 2));
  await writeFile(join(root, 'measurement.json'), JSON.stringify(cohorts[1].measurement, null, 2));
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', scope: 'controlled-sampling-evidence', apkSha256, iterations, warmups, count, windowMs, cohorts, comparison, thresholdPolicy: 'independent first-cohort median plus 25 percent; example policy, not a universal product limit', fixtureReceiptsRemoved: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, comparison }));
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), apkSha256, results, cohorts, lease: await inspectDeviceLock(device) }, null, 2)); throw error;
} finally {
  if (transportObserver) {
    try { await transportObserver.snapshot('sampling-finished', true); }
    finally { await transportObserver.stop(); }
  }
}
