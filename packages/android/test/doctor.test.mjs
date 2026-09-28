import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectAndroidEnvironment } from '../dist/index.js';

test('doctor distinguishes required failures, optional warnings and safe fixes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-doctor-'));
  try {
    const healthy = await inspectAndroidEnvironment({
      root,
      fix: true,
      nodeVersion: 'v22.1.0',
      env: { ANDROID_SDK_ROOT: root },
      run: async (file, args) => {
        if (file === 'adb' && args[0] === 'version') return { stdout: 'Android Debug Bridge version 1.0.41', stderr: '' };
        if (file === 'adb' && args[0] === 'devices') return { stdout: 'List of devices attached\nemulator-5554 device product:test\n', stderr: '' };
        if (file === 'adb' && args[0] === 'start-server') return { stdout: '', stderr: '' };
        if (file === 'python') return { stdout: 'Python 3.11.0', stderr: '' };
        if (file === 'java') return { stdout: '', stderr: 'openjdk version "21"' };
        if (args[0] === '-list-avds') return { stdout: 'Test_AVD\n', stderr: '' };
        throw new Error(`unexpected ${file} ${args.join(' ')}`);
      },
    });
    assert.equal(healthy.verdict, 'ready');
    assert.equal(healthy.summary.failures, 0);
    assert.deepEqual(healthy.fixes, ['Created AppVanta runtime directories', 'Started ADB server']);

    const degraded = await inspectAndroidEnvironment({
      root,
      nodeVersion: 'v20.0.0',
      env: {},
      run: async (file, args) => {
        if (file === 'adb' && args[0] === 'version') return { stdout: 'Android Debug Bridge version 1.0.41', stderr: '' };
        if (file === 'adb' && args[0] === 'devices') return { stdout: 'List of devices attached\n', stderr: '' };
        throw new Error(`${file} missing`);
      },
    });
    assert.equal(degraded.verdict, 'degraded');
    assert(degraded.checks.some(check => check.id === 'devices' && check.status === 'warn'));
    assert(degraded.checks.some(check => check.id === 'python' && check.status === 'warn'));

    const blocked = await inspectAndroidEnvironment({ root, nodeVersion: 'v18.0.0', env: {}, run: async () => { throw new Error('ENOENT'); } });
    assert.equal(blocked.verdict, 'blocked');
    assert(blocked.checks.some(check => check.id === 'node' && check.status === 'fail'));
    assert(blocked.checks.some(check => check.id === 'adb' && check.status === 'fail'));
    const outdated = await inspectAndroidEnvironment({
      root, nodeVersion: 'v22.0.0', env: { ANDROID_SDK_ROOT: root },
      run: async file => file === 'adb' ? { stdout: 'Android Debug Bridge version 1.0.40', stderr: '' } : file === 'python' ? { stdout: 'Python 3.9.9', stderr: '' } : { stdout: '', stderr: 'java version "11"' },
    });
    assert.equal(outdated.verdict, 'blocked');
    assert(outdated.checks.some(check => check.id === 'python' && check.status === 'warn'));
    assert(outdated.checks.some(check => check.id === 'java' && check.status === 'warn'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
