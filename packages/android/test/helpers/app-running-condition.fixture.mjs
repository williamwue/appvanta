import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';

let reply, failure;
mock.module('node:child_process', { namedExports: { ...childProcess,
  execFile: (_file, _args, _options, callback) => queueMicrotask(() => callback(failure, { stdout: reply, stderr: '' })),
} });
const { AdbDriver } = await import('../../dist/adb-driver.js');
const driver = new AdbDriver({ artifactsDirectory: 'unused' });
const check = () => driver.checkCondition('fake', { kind: 'app-running', packageName: 'app.test' });
failure = Object.assign(new Error('adb: device offline'), { code: 1 });
await assert.rejects(check(), /device offline/);
failure = undefined;
reply = '\nAPPVANTA_PIDOF_STATUS=1\n'; assert.equal(await check(), false);
reply = '123 456\nAPPVANTA_PIDOF_STATUS=0\n'; assert.equal(await check(), true);
for (reply of ['123', '', 'pidof: permission denied\nAPPVANTA_PIDOF_STATUS=1\n', '\nAPPVANTA_PIDOF_STATUS=127\n', '\nAPPVANTA_PIDOF_STATUS=0\n', '0\nAPPVANTA_PIDOF_STATUS=0\n']) await assert.rejects(check(), /process query/);
console.log('app-running transport distinction: passed');
