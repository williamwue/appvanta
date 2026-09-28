import test from 'node:test';
import assert from 'node:assert/strict';
import { gesturePayload } from '../dist/index.js';
import { parseAction } from '../../core/dist/index.js';

test('pinch, rotate and custom gestures compile to simultaneous bounded strokes', () => {
  const pinch = parseAction({ kind: 'pinch', center: { x: 500, y: 600 }, startSpan: 400, endSpan: 100, durationMs: 500 });
  assert.deepEqual(gesturePayload(pinch).strokes, [
    { points: [{ x: 300, y: 600 }, { x: 450, y: 600 }] },
    { points: [{ x: 700, y: 600 }, { x: 550, y: 600 }] },
  ]);
  const rotation = gesturePayload(parseAction({ kind: 'rotate-gesture', center: { x: 500, y: 500 }, radius: 100, degrees: 90, durationMs: 800 }));
  assert.equal(rotation.strokes.length, 2); assert.equal(rotation.strokes[0].points.length, 13);
  assert.deepEqual(rotation.strokes[0].points[0], { x: 600, y: 500 });
  assert.deepEqual(rotation.strokes[0].points.at(-1), { x: 500, y: 600 });
  const custom = parseAction({ kind: 'multi-touch', durationMs: 300, strokes: [{ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }, { points: [{ x: 5, y: 6 }, { x: 7, y: 8 }] }] });
  assert.deepEqual(gesturePayload(custom), { durationMs: 300, strokes: custom.strokes });
  for (const value of [
    { kind: 'pinch', center: { x: 10, y: 10 }, startSpan: 100, endSpan: 20, durationMs: 500 },
    { kind: 'pinch', center: { x: 500, y: 500 }, startSpan: 100, endSpan: 100, durationMs: 500 },
    { kind: 'rotate-gesture', center: { x: 500, y: 500 }, radius: 100, degrees: 0, durationMs: 500 },
    { kind: 'multi-touch', durationMs: 300, strokes: [{ points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] },
  ]) assert.throws(() => parseAction(value));
});
