import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeIncidents } from '../dist/runtime-diagnostics.js';
test('diagnostics count incidents, preserve stacks and exclude other packages and old events', () => {
  const event = (time, tag, name, pid = 12) => `${time}.000 1 2 I ${tag}: [0,${pid},${name},0,reason,with,commas]`;
  const crash = '100.000 12 12 E AndroidRuntime: FATAL EXCEPTION: main\n100.001 12 12 E AndroidRuntime: at app.Main.run(Main.java:1)\n100.001 99 99 E AndroidRuntime: unrelated';
  const events = [event(100, 'am_crash', 'app.test'), event(100, 'am_crash', 'app.test'), event(101, 'am_anr', 'app.test:child'), event(90, 'am_crash', 'app.test'), event(100, 'am_crash', 'app.test.other'), 'bad am_anr'].join('\n');
  const result = parseRuntimeIncidents(events, crash, 'app.test', 99000);
  assert.equal(result.incidents.length, 2);
  assert.equal(result.incidents[0].stack.length, 2);
  assert.equal(result.incidents[1].kind, 'anr');
  assert.equal(result.malformedEvents, 1);
  assert.equal(parseRuntimeIncidents(events, crash, 'app.test', 102000).incidents.length, 0);
});
