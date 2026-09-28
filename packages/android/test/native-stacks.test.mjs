import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeIncidents } from '../dist/runtime-diagnostics.js';
import { parseNativeStacks } from '../dist/native-stacks.js';
const block = (writer, process, pid, time = '100.000') => [
  '*** *** *** ***', `pid: ${pid}, ppid: 1, tid: ${pid}, name: test >>> ${process} <<<`,
  'signal 6 (SIGABRT), code -6 (SI_TKILL), fault addr --------',
  'backtrace:', '  #00 pc 00000000abcdef /apex/libc.so (abort+1)',
].map(line => `${time} ${writer} ${writer} F DEBUG: ${line}`).join('\n');
test('Native crash correlation uses tombstone PID, precise app name and unique bounded candidate', () => {
  const logs = block(999, 'app.test', 42) + '\n' + block(998, 'app.test.other', 43);
  const event = '100.100 1 1 I am_crash: [1,0,app.test,123,Native crash,Aborted,unknown,0,0]';
  const incident = parseRuntimeIncidents(event, logs, 'app.test', 99000).incidents[0];
  assert.equal(incident.processId, 42);
  assert.equal(incident.nativeStack.frames.length, 1);
  assert.equal(parseNativeStacks(logs).length, 2);
  for (const source of [block(999, 'app.test.other', 42), block(999, 'app.test', 42, '80.000'), logs + '\n' + block(997, 'app.test', 45)]) {
    assert.equal(parseRuntimeIncidents(event, source, 'app.test', 99000).incidents[0].nativeStack, undefined);
  }
  assert.equal(parseRuntimeIncidents(event.replace('Native crash', 'java.lang.Error'), logs, 'app.test', 99000).incidents[0].nativeStack, undefined);
  assert.equal(parseNativeStacks(logs.replaceAll('*** *** *** ***', 'missing header')).length, 0);
});
