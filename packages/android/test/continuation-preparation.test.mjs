import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { inspectDeviceLock } from '../../core/dist/index.js';

for (const transfers of [1, 3]) test(`dead Android preparation recovers after ${transfers} transfers only with matching evidence`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-preparation-'));
  const run = join(root, 'run'), locks = join(root, 'locks'); await mkdir(run);
  const env = { ...process.env, APPVANTA_LOCK_DIRECTORY: locks };
  const module = new URL('../../core/dist/index.js', import.meta.url).href;
  const children = [];
  const start = async code => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'); children.push({ child, exited });
    await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGKILL'); await exited;
  };
  try {
    await start(`import {withDeviceLock,bindDeviceLockRun} from ${JSON.stringify(module)};
      await withDeviceLock('preparation',async()=>{await bindDeviceLockRun('preparation',${JSON.stringify(run)});process.send('ready');await new Promise(()=>setInterval(()=>{},1000));});`);
    for (let index = 0; index < transfers; index++) {
    const old = (await inspectDeviceLock('preparation', locks)).lease;
    await start(`import {continueRecoveredDevice} from ${JSON.stringify(module)};
      await continueRecoveredDevice('preparation',${JSON.stringify(old.token)},async()=>{},async()=>{process.send('transferred');await new Promise(()=>setInterval(()=>{},1000));},undefined,'android-flow');`);
    }
    const state = await inspectDeviceLock('preparation', locks);
    assert.equal(state.owner, 'dead'); assert.equal(state.lease.runDirectory, await realpath(run));
    assert.equal(state.lease.preparationScope, 'android-flow');
    const path = join(locks, createHash('sha256').update('preparation').digest('hex') + '.json');
    const original = await readFile(path, 'utf8');
    const recover = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import {recoverAndroidFlow} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}; console.log(JSON.stringify(await recoverAndroidFlow('preparation',${JSON.stringify(state.lease.token)})));`], { env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    await writeFile(path, JSON.stringify({ ...state.lease, preparationScope: undefined }));
    assert.notEqual(recover().status, 0);
    await writeFile(path, JSON.stringify({ ...state.lease, recoveredFrom: { ...state.lease.recoveredFrom, token: 'bad' } }));
    assert.notEqual(recover().status, 0);
    await writeFile(path, original);
    const intent = `${path}.binding-${state.lease.token}.json`;
    await writeFile(intent, '{broken');
    assert.notEqual(recover().status, 0, 'Corrupt intent must never fall back to preparation release');
    assert.equal((await inspectDeviceLock('preparation', locks)).lease.token, state.lease.token);
    await rm(intent);
    const result = recover(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).scope, 'pre-continuation-binding');
    assert.equal(await inspectDeviceLock('preparation', locks), null);
  } finally {
    for (const {child,exited} of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
