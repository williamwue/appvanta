import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAction } from '../../core/dist/index.js';
import { fileShareArguments } from '../dist/file-share.js';

test('attachment action accepts only a content URI, explicit MIME and optional destination', () => {
  const action = { kind: 'share-file', uri: 'content://app.files/document/test%20file.bin', mimeType: 'application/octet-stream', packageName: 'app.receiver' };
  assert.deepEqual(parseAction(action), action);
  for (const patch of [{ uri: 'file:///sdcard/test' }, { uri: 'https://example.com/a' }, { uri: 'content:///a' }, { uri: 'content://user@app/a' }, { uri: 'content://app/a\n' }, { mimeType: 'text/plain;bad' }, { mimeType: '*/*' }, { packageName: 'app;echo' }, { unknown: true }]) assert.throws(() => parseAction({ ...action, ...patch }));
});

test('attachment dispatch quotes opaque URI and MIME while granting read access only', () => {
  const uri = "content://app.files/item/quote'$(id);%20";
  const args = fileShareArguments({ kind: 'share-file', uri, mimeType: 'application/octet-stream' });
  assert.deepEqual(args.slice(0, 8), ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.SEND', '-t', "'application/octet-stream'"]);
  assert.equal(args[9], "'content://app.files/item/quote'\"'\"'$(id);%20'");
  assert.equal(args[12], args[9]);
  assert(args.includes('--grant-read-uri-permission'));
  assert(!args.includes('--grant-write-uri-permission'));
  assert(!args.includes('--grant-persistable-uri-permission'));
  assert(!args.includes('-p'));
});
