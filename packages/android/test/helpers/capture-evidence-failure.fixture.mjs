import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as fs from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let finalWritesDenied = 0;
let segmentFailureWritesDenied = 0;
mock.module('node:fs/promises', { namedExports: {
  ...fs,
  writeFile: async (...args) => {
    if (String(args[0]).endsWith('.capture.json') && String(args[1]).includes('"status": "failed"')) {
      finalWritesDenied++;
      throw Object.assign(new Error('injected final capture evidence EACCES'), { code: 'EACCES' });
    }
    if (String(args[0]).endsWith('screen-segments.tmp') && String(args[1]).includes('"status": "failed"')) {
      segmentFailureWritesDenied++;
      throw Object.assign(new Error('injected segment failure evidence EACCES'), { code: 'EACCES' });
    }
    return fs.writeFile(...args);
  },
} });
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  execFile: (_file, args, _options, callback) => {
    const command = String(args.at(-1));
    queueMicrotask(() => command.includes('for n in 1 2 3 4 5')
      ? callback(new Error('injected remote PID cleanup uncertainty'))
      : callback(null, { stdout: command.includes('if [ -f ') && command.includes('.status') ? '1' : '', stderr: '' }));
  },
} });

const { bindDeviceLockRun, createRunContext, executeFlow, inspectDeviceLock, parseFlow, recoverDeviceLock, retainDeviceLockForCleanup, withDeviceLock } = await import('../../../core/dist/index.js');
const { startFlowCapture } = await import('../../dist/flow-capture.js');
const { captureScreenSegments } = await import('../../dist/segmented-screen.js');
const root = await fs.mkdtemp(join(tmpdir(), 'appvanta-capture-evidence-'));
const locks = join(root, 'locks');
const driver = { name: 'fake', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), execute: async () => ({ success: true }), checkCondition: async () => true };
const device = { id: 'device', name: 'device', platform: 'android', status: 'online', capabilities: [] };
try {
  const result = await withDeviceLock('device', async () => {
    const context = await createRunContext({ runsDirectory: join(root, 'runs'), driver, device });
    await bindDeviceLockRun('device', context.rootDirectory, locks, 'android-flow');
    const result = await executeFlow({ context, driver, flow: parseFlow({ name: 'capture evidence failure', capture: { screenSeconds: 1 }, steps: [{ description: 'note', echo: 'ok' }] }), startCapture: startFlowCapture });
    if (result.cleanupFailed) await retainDeviceLockForCleanup('device', result.runDirectory, locks);
    return result;
  }, locks);
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.status, 'failed');
  assert.equal(finalWritesDenied, 1);
  const state = await inspectDeviceLock('device', locks);
  assert.equal(state.lease.cleanupRequired.runDirectory, result.runDirectory);
  const summary = JSON.parse(await fs.readFile(join(result.runDirectory, 'captures', 'summary.json'), 'utf8'));
  assert.match(summary.records[0].error, /remote PID cleanup uncertainty/);
  assert.match(summary.records[0].error, /final capture evidence EACCES/);
  assert.match(result.steps[0].message, /remote PID cleanup uncertainty/);
  await recoverDeviceLock('device', state.lease.token, async () => {}, locks);

  const segments = join(root, 'segments');
  await fs.mkdir(segments);
  const stop = new AbortController();
  await assert.rejects(captureScreenSegments('adb', 'device', segments, 6, 5, { ready() {}, stop: stop.signal }), error => {
    assert.equal(error.code, 'APPVANTA_RESTORATION_UNVERIFIED');
    assert.match(String(error.errors[0]), /Capture cleanup or final evidence could not be verified/);
    assert.match(String(error.errors[1]), /segment failure evidence EACCES/);
    return true;
  });
  assert.equal(segmentFailureWritesDenied, 1);
  console.log('capture-evidence-failure: passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
