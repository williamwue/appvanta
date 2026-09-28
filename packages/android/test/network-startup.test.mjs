import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { bindDeviceLockRun, createRunContext, executeFlow, inspectDeviceLock, parseFlow, recoverDeviceLock, retainDeviceLockForCleanup, withDeviceLock } from '@appvanta/core';

test('worker exit before readiness with unverified proxy restoration retains the Flow lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-network-startup-'));
  const moduleRoot = join(root, 'adapter');
  const locks = join(root, 'locks');
  try {
    await mkdir(join(moduleRoot, 'runtime'), { recursive: true });
    await copyFile(new URL('../dist/network-session.js', import.meta.url), join(moduleRoot, 'network-session.mjs'));
    await writeFile(join(moduleRoot, 'runtime/capture-network.py'), `const fs = require('node:fs'); const path = require('node:path'); const output = process.argv[process.argv.indexOf('--output') + 1]; fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ proxyRestored: false })); process.exit(7);`);
    const { startNetwork } = await import(pathToFileURL(join(moduleRoot, 'network-session.mjs')).href);
    await assert.rejects(startNetwork({ python: join(root, 'missing-worker'), mitmdump: 'unused' }, 'device', join(root, 'never-started')), { code: 'ENOENT' });
    const driver = { name: 'fake', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), execute: async () => ({ success: true }), checkCondition: async () => true };
    const device = { id: 'device', name: 'device', platform: 'android', status: 'online', capabilities: [] };
    let runDirectory;
    await withDeviceLock('device', async () => {
      const context = await createRunContext({ runsDirectory: join(root, 'runs'), driver, device });
      await bindDeviceLockRun('device', context.rootDirectory, locks, 'android-flow');
      const result = await executeFlow({ context, driver, flow: parseFlow({ name: 'network startup', network: { python: process.execPath, mitmdump: 'unused' }, steps: [{ description: 'note', echo: 'ok' }] }), startNetwork });
      runDirectory = result.runDirectory;
      assert.equal(result.status, 'failed');
      assert.equal(result.cleanupFailed, true);
      assert.match(result.steps[0].message, /Network proxy restoration was not verified/);
      await retainDeviceLockForCleanup('device', runDirectory, locks);
    }, locks);
    const state = await inspectDeviceLock('device', locks);
    assert.equal(state.lease.cleanupRequired.runDirectory, state.lease.runDirectory);
    assert.equal(state.lease.runDirectory, await realpath(runDirectory));
    assert.equal(JSON.parse(await readFile(join(runDirectory, 'network/summary.json'), 'utf8')).proxyRestored, false);
    await assert.rejects(recoverDeviceLock('device', state.lease.token, async () => { throw new Error('proxy still unverified'); }, locks), /proxy still unverified/);
    await recoverDeviceLock('device', state.lease.token, async () => {}, locks);
  } finally { await rm(root, { recursive: true, force: true }); }
});
