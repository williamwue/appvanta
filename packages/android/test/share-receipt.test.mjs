import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAttachmentShareReceipt, readAttachmentShare } from '../dist/multi-file-share.js';

const operation = '11111111-2222-3333-4444-555555555555';
const receipt = { version: 1, operation, state: 'dispatched', count: 2, mimeType: 'application/octet-stream', uris: ['content://files/a', 'content://files/b'] };
test('receipt inspection binds identity, states, URI types and count', () => {
  assert.deepEqual(parseAttachmentShareReceipt(JSON.stringify(receipt), operation), receipt);
  for (const state of ['prepared', 'cancelled', 'rejected']) assert.equal(parseAttachmentShareReceipt(JSON.stringify({ ...receipt, state, uris: [] }), operation).state, state);
  for (const patch of [{ version: 2 }, { operation: 'other' }, { state: 'passed' }, { count: 1 }, { count: 17 }, { uris: [receipt.uris[0]] }, { uris: [receipt.uris[0], receipt.uris[0]] }, { uris: ['file:///a', receipt.uris[1]] }, { mimeType: '*/*' }, { packageName: 'bad;command' }, { resumeAuthorized: true }, { error: 'unexpected' }]) {
    assert.throws(() => parseAttachmentShareReceipt(JSON.stringify({ ...receipt, ...patch }), operation));
  }
  assert.throws(() => parseAttachmentShareReceipt(JSON.stringify({ ...receipt, state: 'prepared', uris: [], mimeType: '*/*' }), operation));
});
test('receipt read performs only content read and hashes exact bytes without authorizing resume', async () => {
  const raw = JSON.stringify(receipt, null, 2) + '\n'; const calls = [];
  const result = await readAttachmentShare(operation, async args => { calls.push(args); return raw; });
  assert.deepEqual(calls, [['exec-out', 'content', 'read', '--uri', `content://dev.appvanta.share.helper/operations/${operation}`]]);
  assert.equal(result.resumeAuthorized, false); assert.equal(result.scope, 'read-only');
  assert.equal(result.receiptSha256, createHash('sha256').update(raw).digest('hex'));
  await assert.rejects(readAttachmentShare('../escape', async () => { throw new Error('must not execute'); }), /Invalid attachment operation/);
});
