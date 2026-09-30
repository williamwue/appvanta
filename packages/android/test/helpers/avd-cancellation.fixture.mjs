import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let controller, scenario, calls, spawned;
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  execFile: (_file, args, options, callback) => {
    calls.push(args);
    let stdout = args.includes('-list-avds') ? 'Fixture\n' : args[0] === 'devices'
      ? (scenario === 'new' ? 'List of devices attached\n' : 'List of devices attached\nemulator-5554\tdevice\n')
      : args.includes('getprop') ? '1' : 'Fixture\nOK';
    if (args.includes('getprop')) {
      assert.equal(options.signal, controller.signal);
      if (scenario === 'poll-delay') {
        stdout = '0';
        setTimeout(() => controller.abort(new Error('cancel during polling delay')), 10);
      } else controller.abort(new Error('cancel during boot probe'));
    }
    queueMicrotask(() => callback(null, { stdout, stderr: '' }));
  },
  spawn: () => {
    spawned++;
    return Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null,
      unref() {}, kill() { throw new Error('Must not terminate emulator'); } });
  },
} });
const { startAndroidAvd } = await import('../../dist/start-avd.js');
const { inspectDeviceLock } = await import('@appvanta/core');
const root = await mkdtemp(join(tmpdir(), 'appvanta-avd-cancel-'));
const previous = process.cwd();
process.chdir(root);
try {
  controller = new AbortController(); calls = []; spawned = 0;
  controller.abort(new Error('pre-cancelled'));
  await assert.rejects(startAndroidAvd('Fixture', 5554, 1000, undefined, controller.signal), /pre-cancelled/);
  assert.equal(calls.length, 0);
  for (scenario of ['new', 'reused', 'poll-delay']) {
    controller = new AbortController(); calls = []; spawned = 0;
    const before = new Set(await readdir('.appvanta/emulators').catch(() => []));
    await assert.rejects(startAndroidAvd('Fixture', 5554, 1000, undefined, controller.signal), /cancelled/);
    const created = (await readdir('.appvanta/emulators')).filter(name => !before.has(name));
    assert.equal(created.length, 1);
    const record = JSON.parse(await readFile(join('.appvanta/emulators', created[0], 'startup.json')));
    assert.equal(record.status, 'cancelled');
    assert.equal(record.reused, scenario !== 'new');
    assert.equal(spawned, scenario === 'new' ? 1 : 0);
    assert.equal(await inspectDeviceLock('emulator-5554'), null);
    assert.equal(await inspectDeviceLock('avd:Fixture'), null);
  }
  console.log(JSON.stringify({ status: 'passed', root }));
} finally { process.chdir(previous); }
