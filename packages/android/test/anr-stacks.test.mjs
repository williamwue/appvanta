import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAnrStack } from '../dist/anr-stacks.js';
test('ANR threads require matching process, PID, bounded timestamp and complete section', () => {
  const incident = { kind: 'anr', processId: 42, processName: 'app.test', timestampMs: Date.parse('2026-09-16T05:18:09Z') };
  const block = `----- pid 42 at 2026-09-16 05:18:09.887626821+0000 -----\nCmd line: app.test\n"main" prio=5 tid=1 Sleeping\n  at app.test.Block.wait(Block.java:1)\n\n"worker" prio=5 tid=2 Runnable\n  at app.test.Work.run(Work.java:1)\n----- end 42 -----`;
  const matched = matchAnrStack(block, incident);
  assert.equal(matched.threads.length, 2);
  assert.equal(matched.threads[0].state, 'Sleeping');
  assert(matched.threads[0].lines.some(line => line.includes('Block.wait')));
  for (const wrong of [block.replace('Cmd line: app.test', 'Cmd line: other.app'), block.replaceAll('42', '43'), block.replace('05:18:09.', '05:19:09.'), block.replace('----- end 42 -----', '')]) assert.equal(matchAnrStack(wrong, incident), undefined);
  assert.equal(matchAnrStack(block, { ...incident, kind: 'crash' }), undefined);
});
