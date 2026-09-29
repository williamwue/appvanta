import test from 'node:test';
import assert from 'node:assert/strict';
import { accelerationSequence, parseEmulatorAcceleration } from '../dist/emulator-sensors.js';

test('emulator acceleration parsing requires a complete acknowledged finite vector', () => {
  assert.deepEqual(parseEmulatorAcceleration('acceleration = 0:9.77631:0.812349\r\r\nOK\r\r\n'), [0, 9.77631, 0.812349]);
  for (const value of ['acceleration = 0:1:2', 'KO: disabled\n', 'acceleration = NaN:1:2\nOK\n', 'acceleration = :1:2\nOK\n', 'acceleration = 201:1:2\nOK\n']) assert.throws(() => parseEmulatorAcceleration(value));
});
test('shake sequences preserve gravity and reject unbounded sensor injections', () => {
  const original = [0, 9.8, 0.8], options = { axis: 'x', amplitude: 12, cycles: 2, intervalMs: 100 };
  assert.deepEqual(accelerationSequence(original, options), [[12, 9.8, 0.8], [-12, 9.8, 0.8], [12, 9.8, 0.8], [-12, 9.8, 0.8]]);
  assert.deepEqual(original, [0, 9.8, 0.8]);
  for (const patch of [{ axis: 'w' }, { amplitude: Infinity }, { amplitude: 31 }, { cycles: 0 }, { cycles: 1.5 }, { intervalMs: 49 }]) assert.throws(() => accelerationSequence(original, { ...options, ...patch }));
});
