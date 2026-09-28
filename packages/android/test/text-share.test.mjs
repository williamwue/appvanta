import test from 'node:test';
import assert from 'node:assert/strict';
import { textShareArguments } from '../dist/text-share.js';

test('text sharing preserves Unicode and quotes remote shell metacharacters', () => {
  const text = "中文🙂\n'quoted' \"double\" $(echo bad); %s";
  const args = textShareArguments({ kind: 'share-text', text, subject: 'Title', packageName: 'net.gsantner.markor' });
  assert.deepEqual(args.slice(0, 8), ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.SEND', '-t', 'text/plain']);
  assert.equal(args[10], "'中文🙂\n'\"'\"'quoted'\"'\"' \"double\" $(echo bad); %s'");
  assert.deepEqual(args.slice(11), ['--es', 'android.intent.extra.SUBJECT', "'Title'", '-p', 'net.gsantner.markor']);
  assert.equal(textShareArguments({ kind: 'share-text', text: 'plain' }).length, 11);
});

test('text sharing rejects invalid or oversized input before ADB', () => {
  for (const patch of [{ text: '' }, { text: ' ' }, { text: 'a\0b' }, { text: '中'.repeat(2731) },
    { subject: '' }, { subject: 'x\0y' }, { subject: '中'.repeat(342) }, { packageName: 'app.test;bad' }, { unknown: true }]) {
    assert.throws(() => textShareArguments({ kind: 'share-text', text: 'valid', ...patch }));
  }
});
