import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as fs from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scenario = process.argv[2];
let denied = false;
let calls = [];
let externalEffect = false;
mock.module('node:fs/promises', { namedExports: {
  ...fs,
  writeFile: async (...args) => {
    if (scenario === 'marker-denied' && String(args[0]).endsWith('pre-flow-failure.json')) {
      denied = true;
      throw Object.assign(new Error('injected pre-Flow marker EACCES'), { code: 'EACCES' });
    }
    return fs.writeFile(...args);
  },
} });
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  execFile: (_file, args, _options, callback) => {
    calls.push(args.join(' '));
    const changesProxy = args.join(' ') === '-s device shell settings put global http_proxy 127.0.0.1:8080';
    if (changesProxy) externalEffect = true;
    const output = args[0] === 'devices' ? 'List of devices attached\ndevice\tdevice model:fake\n'
      : args.at(-1) === 'ro.product.model' ? 'fake\n'
      : args.at(-1) === 'ro.build.fingerprint' ? 'fake-build\n'
      : changesProxy ? ''
      : null;
    queueMicrotask(() => output === null ? callback(new Error(`unexpected device command: ${args.join(' ')}`)) : callback(null, { stdout: output, stderr: '' }));
  },
} });

const { runAndroidFlow } = await import('../../dist/flow.js');
const { recoverAndroidFlow } = await import('../../dist/recover-flow.js');
const { inspectDeviceLock, withDeviceLock } = await import('../../../core/dist/index.js');
const { execFile } = await import('node:child_process');
const locks = join(process.cwd(), 'locks');
process.env.APPVANTA_LOCK_DIRECTORY = locks;
let run;
const errorMessages = error => {
  const messages = [String(error)];
  if (error && Array.isArray(error.errors)) for (const child of error.errors) messages.push(...errorMessages(child));
  if (error?.cause) messages.push(...errorMessages(error.cause));
  return messages;
};
await assert.rejects(runAndroidFlow('device', { name: 'pre-flow callback failure', steps: [{ description: 'note', echo: 'ok' }] }, undefined, async root => {
  run = root;
  if (scenario === 'partial') await fs.writeFile(join(root, 'progress.json'), '{"phase":"executing"}');
  if (scenario === 'unsafe-child') await assert.rejects(withDeviceLock('device', async () => {
    throw Object.assign(new Error('injected unsafe child cleanup'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
  }, locks), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
  if (scenario === 'external-effect') await promisify(execFile)('adb', ['-s', 'device', 'shell', 'settings', 'put', 'global', 'http_proxy', '127.0.0.1:8080'], { encoding: 'utf8' });
  throw Object.assign(new Error('injected task persistence failure'), { code: 'EACCES' });
}), error => {
  const messages = errorMessages(error);
  if (scenario === 'marker-denied') {
    assert(messages.some(message => /task persistence failure/.test(message)) || /Pre-Flow lease binding changed/.test(String(error)));
    assert.equal(denied, true);
    assert(messages.some(message => /marker EACCES/.test(message)) || /Pre-Flow lease binding changed/.test(String(error)));
  } else assert(messages.some(message => /task persistence failure/.test(message)));
  return true;
});
const expectedCalls = ['-s device shell getprop ro.build.fingerprint', '-s device shell getprop ro.product.model', 'devices -l'];
if (scenario === 'external-effect') expectedCalls.push('-s device shell settings put global http_proxy 127.0.0.1:8080');
assert.deepEqual([...calls].sort(), expectedCalls.sort());
assert.equal(externalEffect, scenario === 'external-effect');
const state = await inspectDeviceLock('device', locks);
assert.equal(await fs.realpath(state.lease.runDirectory), await fs.realpath(run));
assert.equal(await fs.realpath(state.lease.cleanupRequired.runDirectory), await fs.realpath(run));
assert.equal(state.lease.cleanupRequired.reason, scenario === 'unsafe-child' ? 'nested-exit' : 'operation-exit');
await assert.rejects(fs.readFile(join(run, 'flow.json')), { code: 'ENOENT' });
await assert.rejects(recoverAndroidFlow('device', state.lease.token), error => {
  assert.equal(error.code, 'APPVANTA_MANUAL_RECOVERY_REQUIRED');
  assert.match(error.message, scenario === 'unsafe-child' ? /Manual review required:.*nested operation/ : /Manual review required:.*onRunCreated/);
  return true;
});
assert.equal((await inspectDeviceLock('device', locks)).lease.token, state.lease.token);
if (scenario === 'marker-denied') assert.equal(denied, true);
assert.equal(calls.length, expectedCalls.length, 'failed recovery must not issue device commands');
console.log(`${scenario}: passed`);
