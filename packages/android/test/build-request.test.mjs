import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeGradleBridgeRequest } from '../dist/build-request.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-build-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { path: join(root, '请求🚀.bin'), request: { installation: root, project: root, userHome: root, receipt: join(root, 'receipt.json'), tasks: [':app:assembleDebug', '中文任务'], arguments: ['-Pvalue=中文 🚀\nnext line ; & ='] } };
}

test('versioned request preserves Unicode fields and exposes only ASCII launcher arguments', async t => {
  const { path, request } = await fixture(t);
  const result = await writeGradleBridgeRequest(path, request);
  const bytes = await readFile(path);
  assert.equal(bytes.readUInt32BE(0), 0x41564731);
  const count = bytes.readUInt32BE(4), values = [];
  let offset = 8;
  for (let i = 0; i < count; i++) {
    const length = bytes.readUInt32BE(offset); offset += 4;
    values.push(bytes.subarray(offset, offset + length).toString('utf8')); offset += length;
  }
  assert.equal(offset, bytes.length);
  assert.deepEqual(values, [request.installation, request.project, request.userHome, request.receipt, '2', ...request.tasks, ...request.arguments]);
  assert(result.launcherArguments.every(value => /^[\x20-\x7e]+$/.test(value)));
  assert.equal(Buffer.from(result.launcherArguments[1], 'base64').toString('utf8'), path);
  assert.equal(result.requestSha256, createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(writeGradleBridgeRequest(path, request), { code: 'EEXIST' });
  assert.deepEqual(await readFile(path), bytes);
});

test('invalid paths, tasks, Unicode and oversized requests fail before creating a file', async t => {
  const { path, request } = await fixture(t);
  for (const change of [{ project: '.' }, { tasks: [] }, { tasks: ['--stop'] }, { arguments: ['\ud800'] },
    { arguments: ['a\0b'] }, { arguments: ['x'.repeat(1024 * 1024 + 1)] }, { arguments: Array(5).fill('x'.repeat(1024 * 1024)) }]) {
    await assert.rejects(writeGradleBridgeRequest(path, { ...request, ...change }));
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
});
