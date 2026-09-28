import test from 'node:test';
import assert from 'node:assert/strict';
import { listAndroidAvds, startAndroidAvd } from '../dist/index.js';

test('AVD startup rejects invalid names, ports and deadlines before invoking tools', async () => {
  await assert.rejects(startAndroidAvd('Test', 5554, 120000, 'bad;mode'), /GPU mode/);
  for (const args of [['bad name'], ['valid', 5555], ['valid', 1], ['valid', 5554, 0], ['valid', 5554, Infinity]]) await assert.rejects(startAndroidAvd(...args));
});

test('AVD inventory respects explicit executable, SDK and PATH without invoking a shell', async () => {
  for (const env of [{ APPVANTA_EMULATOR_PATH: 'custom emulator', ANDROID_SDK_ROOT: 'ignored' }, { ANDROID_SDK_ROOT: 'sdk root' }, {}]) {
    let command;
    const result = await listAndroidAvds({ env, run: async (file, args) => {
      command = { file, args }; return { stdout: 'Pixel_9\r\nTest_API37\r\nPixel_9\r\n', stderr: 'diagnostic' };
    } });
    assert.deepEqual(command.args, ['-list-avds']);
    assert.deepEqual(result.avds, [{ name: 'Pixel_9' }, { name: 'Test_API37' }]);
    assert.equal(result.diagnostics, 'diagnostic');
    if (env.APPVANTA_EMULATOR_PATH) assert.equal(command.file, 'custom emulator');
    else if (env.ANDROID_SDK_ROOT) assert(command.file.startsWith('sdk root'));
    else assert.equal(command.file, 'emulator');
  }
  assert.deepEqual((await listAndroidAvds({ env: {}, run: async () => ({ stdout: '\n', stderr: '' }) })).avds, []);
  await assert.rejects(listAndroidAvds({ env: {}, run: async () => ({ stdout: 'unexpected log line', stderr: '' }) }), /invalid AVD/);
  await assert.rejects(listAndroidAvds({ env: {}, run: async () => { throw new Error('not installed'); } }), /not installed/);
});
