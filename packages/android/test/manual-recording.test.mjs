import test from 'node:test';
import assert from 'node:assert/strict';
import { compileManualRecording } from '../dist/index.js';

const line = value => JSON.stringify({ version: 1, timestamp: 1000 + value.sequence, packageName: 'app.test', ...value });
test('manual Accessibility events compile to replayable semantic Flow actions', () => {
  const target = { resourceId: 'app.test:id/editor', left: 10, top: 20, right: 210, bottom: 120 };
  const jsonl = [
    line({ sequence: 1, kind: 'click', target: { resourceId: 'app.test:id/save', left: 0, top: 0, right: 80, bottom: 40 } }),
    line({ sequence: 2, kind: 'long-click', target: { contentDescription: 'Options', left: 10, top: 10, right: 90, bottom: 50 } }),
    line({ sequence: 3, kind: 'scroll', target: { left: 0, top: 100, right: 400, bottom: 700 }, scrollDeltaY: 200, scrollDeltaX: 0 }),
    line({ sequence: 4, kind: 'text-change', target, beforeText: '', afterText: '你' }),
    line({ sequence: 5, kind: 'text-change', target, beforeText: '你', afterText: '你好' }),
  ].join('\n');
  const result = compileManualRecording(jsonl, 'Manual test');
  assert.equal(result.eventCount, 5); assert.equal(result.ignoredCount, 0); assert.equal(result.flow.name, 'Manual test');
  assert.deepEqual(result.flow.applications, ['app.test']);
  assert.equal(result.flow.steps.length, 4);
  assert.deepEqual(result.flow.steps.map(step => step.action.kind), ['tap', 'long-press', 'swipe', 'input']);
  assert.deepEqual(result.flow.steps[0].action.target, { kind: 'resource-id', value: 'app.test:id/save' });
  assert.deepEqual(result.flow.steps[1].action.target, { kind: 'accessibility-label', value: 'Options' });
  assert.deepEqual(result.flow.steps[2].action, { kind: 'swipe', from: { x: 200, y: 680 }, to: { x: 200, y: 120 }, durationMs: 500 });
  assert.equal(result.flow.steps[3].action.text, '你好');
});

test('manual recording rejects edits it cannot safely replay and damaged sequences', () => {
  const target = { resourceId: 'app.test:id/editor', left: 0, top: 0, right: 100, bottom: 50 };
  assert.throws(() => compileManualRecording(line({ sequence: 1, kind: 'text-change', target, beforeText: 'abc', afterText: 'ab' })), /not an append/);
  assert.throws(() => compileManualRecording(line({ sequence: 2, kind: 'click', target })), /event 1/);
  assert.throws(() => compileManualRecording(line({ sequence: 1, kind: 'scroll', target, scrollDeltaX: 0, scrollDeltaY: 0 })), /no replayable/);
});
