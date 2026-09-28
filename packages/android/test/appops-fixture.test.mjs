import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAppOpMode } from '../dist/appops-fixture.js';
test('AppOps fixture parser distinguishes package overrides, defaults and UID overrides', () => {
  assert.equal(parseAppOpMode('No operations.\nDefault mode: allow', 'CAMERA'), 'default');
  assert.equal(parseAppOpMode('CAMERA: ignore; rejectTime=+1s ago', 'CAMERA'), 'ignore');
  for (const raw of ['Uid mode: CAMERA: ignore\nCAMERA: allow', 'OTHER: allow', 'CAMERA: foreground', 'CAMERA: allow\nCAMERA: deny', 'unknown output']) assert.throws(() => parseAppOpMode(raw, 'CAMERA'));
  assert.throws(() => parseAppOpMode('No operations.', 'INVALID;COMMAND'));
});
