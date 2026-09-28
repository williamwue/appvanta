import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectDeviceLock } from '../../core/dist/index.js';

test('failed Android binding can recover only with matching intent and no execution evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-binding-recovery-'));
  const run = join(root, 'run'), locks = join(root, 'locks');
  await mkdir(run); await mkdir(join(run, 'device-lease.json'));
  await writeFile(join(run, 'run.json'), JSON.stringify({ status: 'planned' }));
  const source = `
    import { withDeviceLock, bindDeviceLockRun } from ${JSON.stringify(new URL('../../core/dist/index.js', import.meta.url).href)};
    await withDeviceLock('binding-test', async () => {
      try { await bindDeviceLockRun('binding-test', ${JSON.stringify(run)}, undefined, 'android-flow'); throw new Error('Expected binding failure'); }
      catch (error) { if (!['EEXIST', 'EISDIR', 'EPERM'].includes(error.code)) throw error; }
      process.send('ready'); await new Promise(() => setInterval(() => {}, 1000));
    });`;
  const env = { ...process.env, APPVANTA_LOCK_DIRECTORY: locks };
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.kill('SIGKILL'); await exited;
    const state = await inspectDeviceLock('binding-test', locks);
    assert.equal(state.owner, 'dead'); assert.equal(state.lease.runDirectory, undefined);
    const recover = () => spawnSync(process.execPath, ['--input-type=module', '-e', `import { recoverAndroidFlow } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}; console.log(JSON.stringify(await recoverAndroidFlow('binding-test', ${JSON.stringify(state.lease.token)})));`], { env, encoding: 'utf8', windowsHide: true });
    await writeFile(join(run, 'flow.json'), '{}');
    assert.notEqual(recover().status, 0);
    assert.equal((await inspectDeviceLock('binding-test', locks)).lease.token, state.lease.token);
    await rm(join(run, 'flow.json'));
    const intentPath = join(locks, (await readdir(locks)).find(name => name.includes('.binding-')));
    const original = await readFile(intentPath, 'utf8');
    const altered = JSON.parse(original); altered.lease.token = '00000000-0000-0000-0000-000000000000';
    await writeFile(intentPath, JSON.stringify(altered));
    assert.notEqual(recover().status, 0);
    await writeFile(intentPath, original);
    const recovered = recover(); assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).scope, 'pre-flow-binding');
    assert.equal(await inspectDeviceLock('binding-test', locks), null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
