import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDeviceLock, recoverDeviceLock } from '@appvanta/core';
import { parseManagedUploadReceipt, uploadAndroidAttachment, recoverAndroidUpload, inspectAndroidUpload } from '../dist/managed-upload.js';

test('managed upload query parser requires exact bounded typed metadata', () => {
  const row = `Row: 0 state=ready, _size=0, sha256=${'a'.repeat(64)}, mimeType=application/octet-stream\r\n`;
  assert.equal(parseManagedUploadReceipt(row).size, 0);
  assert.equal(parseManagedUploadReceipt('No result found.\r\n'), null);
  for (const invalid of [row + 'Row: 1 state=ready', row.replace('ready', 'passed'), row.replace('_size=0', '_size=67108865'), row.replace('_size=0', '_size=-1'), row.replace('application/octet-stream', '*/*'), row.replace('a'.repeat(64), 'invalid'), 'Error: No result found.']) assert.throws(() => parseManagedUploadReceipt(invalid));
});

test('managed upload validation rejects unsafe IDs and names before device use', async () => {
  const options = { directory: 'unused', adbPath: 'never-run-this-adb' };
  await assert.rejects(inspectAndroidUpload('offline', '../other', options), /Invalid upload ID/);
  await assert.rejects(uploadAndroidAttachment('offline', 'unused', '*/*', options));
  for (const name of ['../file', 'a\\b', 'a\nb', 'a\u0000b']) await assert.rejects(uploadAndroidAttachment('offline', 'unused', 'text/plain', options, name), /display name/);
});

test('failed upload preserves snapshot and bound lease; altered request cannot authorize recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-upload-'));
  const device = `offline-upload-${randomUUID()}`;
  const source = join(root, 'input.bin'), payload = Buffer.from([0, 26, 255, 13, 10]);
  const options = { directory: root, adbPath: join(root, 'nonexistent-adb-executable') };
  await writeFile(source, payload);
  let state;
  try {
    await assert.rejects(uploadAndroidAttachment(device, source, 'application/octet-stream', options), /Upload incomplete/);
    state = await inspectDeviceLock(device); assert(state?.lease.runDirectory);
    const directory = state.lease.runDirectory;
    assert.deepEqual(await readFile(join(directory, 'payload.bin')), payload);
    await writeFile(source, 'changed source');
    assert.deepEqual(await readFile(join(directory, 'payload.bin')), payload);
    const raw = await readFile(join(directory, 'request.json'), 'utf8');
    const request = JSON.parse(raw);
    assert.equal(request.sha256, createHash('sha256').update(payload).digest('hex'));
    assert.equal(request.size, payload.length);
    assert((await readdir(directory)).includes('failure.json'));
    await assert.rejects(recoverAndroidUpload(device, randomUUID(), options), /lease changed/);
    await writeFile(join(directory, 'request.json'), raw + ' ');
    await assert.rejects(recoverAndroidUpload(device, state.lease.token, options), /binding mismatch/);
    assert.deepEqual((await inspectDeviceLock(device)).lease, state.lease);
    await writeFile(join(directory, 'request.json'), raw);
  } finally {
    if (state) await recoverDeviceLock(device, state.lease.token, async () => {});
    await rm(root, { recursive: true, force: true });
  }
});
