import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const scenario = process.argv[2], device = 'emulator-5554';
const original = [0, 9.8, 0.8];
let current = [12, 9.8, 0.8];
const calls = [];
mock.module('node:child_process', { namedExports: { ...childProcess, execFile: (_file, args, _options, callback) => {
  calls.push(args);
  const operation = args[4];
  if (operation === 'set') current = args[6].split(':').map(Number);
  assert(['set', 'get'].includes(operation));
  queueMicrotask(() => callback(null, { stdout: operation === 'set' ? 'OK\n' : `acceleration = ${current.join(':')}\nOK\n`, stderr: '' }));
} } });
const { restoreEmulatorShake, accelerationSequence } = await import('../../dist/emulator-sensors.js');
const root = await mkdtemp(join(tmpdir(), 'appvanta-sensor-recovery-'));
try {
  const path = join(root, 'shake.json');
  const options = { axis: 'x', amplitude: 12, cycles: 1, intervalMs: 100 };
  const record = { version: 1, device, original, sequence: accelerationSequence(original, options), options };
  if (scenario === 'invalid-sequence') record.sequence[0][0] = 11;
  const bytes = JSON.stringify(record);
  await writeFile(path, bytes);
  const receipt = JSON.stringify({ version: 1, device, sourceSha256: createHash('sha256').update(bytes).digest('hex'), restored: original, restoredAt: new Date().toISOString() });
  if (scenario === 'completed-later-change') {
    await writeFile(`${path}.restored.json`, receipt);
    await restoreEmulatorShake('adb', device, path);
    assert.equal(calls.length, 0, 'Completed recovery must not touch a later device state');
    assert.equal(await readFile(`${path}.restored.json`, 'utf8'), receipt);
  } else if (scenario === 'restore-once') {
    await restoreEmulatorShake('adb', device, path);
    assert.deepEqual(current, original);
    assert.equal(calls.filter(args => args[4] === 'set').length, 1);
    const saved = await readFile(`${path}.restored.json`, 'utf8');
    const count = calls.length;
    await restoreEmulatorShake('adb', device, path);
    assert.equal(calls.length, count);
    assert.equal(await readFile(`${path}.restored.json`, 'utf8'), saved);
  } else {
    if (scenario === 'corrupt-receipt') await writeFile(`${path}.restored.json`, '{');
    if (scenario === 'foreign-receipt') await writeFile(`${path}.restored.json`, receipt.replace(JSON.parse(receipt).sourceSha256, '0'.repeat(64)));
    await assert.rejects(restoreEmulatorShake('adb', device, path));
    assert.equal(calls.length, 0, 'Invalid evidence must be rejected before device commands');
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
} finally { await rm(root, { recursive: true, force: true }); }
