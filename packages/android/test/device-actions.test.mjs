import test from 'node:test';
import assert from 'node:assert/strict';
import { androidKeyCode, androidRotation } from '../dist/index.js';

test('hardware buttons and orientations map to stable Android input values', () => {
  assert.deepEqual([
    'home', 'back', 'power', 'volume-up', 'volume-down', 'mute', 'app-switch', 'enter', 'menu',
    'dpad-up', 'dpad-down', 'dpad-left', 'dpad-right', 'dpad-center',
  ].map(androidKeyCode), [3, 4, 26, 24, 25, 164, 187, 66, 82, 19, 20, 21, 22, 23]);
  assert.deepEqual([
    'portrait', 'landscape-left', 'portrait-upside-down', 'landscape-right',
  ].map(androidRotation), [0, 1, 2, 3]);
});
