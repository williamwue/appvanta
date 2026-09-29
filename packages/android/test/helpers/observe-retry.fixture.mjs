import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const transient = 'ERROR: null root node returned by UiTestAutomationBridge.\n';
let replies, calls, controller, abortOnDump;
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  execFile: (_file, args, _options, callback) => {
    calls.push([...args]);
    const stdout = args.includes('screencap') ? Buffer.from('screenshot') : replies.shift() ?? transient;
    queueMicrotask(() => {
      callback(null, { stdout, stderr: '' });
      if (abortOnDump && args.includes('uiautomator')) controller.abort(new Error('cancelled observation'));
    });
  },
} });
const { AdbDriver } = await import('../../dist/adb-driver.js');
const root = await mkdtemp(join(tmpdir(), 'appvanta-observe-retry-'));
try {
  for (const scenario of ['recovers', 'exhausted', 'malformed', 'cancelled']) {
    calls = []; controller = new AbortController(); abortOnDump = scenario === 'cancelled';
    replies = scenario === 'recovers' ? [transient, '<hierarchy rotation="0"/>'] : scenario === 'malformed' ? ['unrelated malformed reply'] : [transient, transient, transient];
    const directory = join(root, scenario);
    const driver = new AdbDriver({ artifactsDirectory: directory, signal: controller.signal });
    if (scenario === 'recovers') {
      const result = await driver.observe('test-device');
      assert.equal(await readFile(result.uiTreePath, 'utf8'), '<hierarchy rotation="0"/>');
      assert.equal(result.metadata.uiObservationAttempts, '2');
      const evidence = JSON.parse(await readFile(result.metadata.observationAttemptsPath, 'utf8'));
      assert.equal(evidence.attempts.length, 2);
      assert.equal(evidence.attempts[0].status, 'transient-null-root');
    } else await assert.rejects(driver.observe('test-device'), scenario === 'exhausted' ? /after 3 attempts/ : scenario === 'malformed' ? /UI tree is missing/ : /aborted|cancelled/);
    const expected = scenario === 'recovers' ? 2 : scenario === 'exhausted' ? 3 : 1;
    assert.equal(calls.filter(args => args.includes('uiautomator')).length, expected);
    assert.equal(calls.filter(args => args.includes('screencap')).length, expected);
    const xml = (await readdir(directory)).filter(name => name.endsWith('.xml'));
    assert.equal(xml.length, expected);
    if (scenario !== 'malformed') assert((await Promise.all(xml.map(name => readFile(join(directory, name), 'utf8')))).includes(transient));
  }
  console.log('observe-retry: passed');
} finally { await rm(root, { recursive: true, force: true }); }
