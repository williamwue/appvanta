import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shareFiles } from '../dist/multi-file-share.js';

const action = { kind: 'share-files', uris: ['content://app.files/a', 'content://app.files/b'], mimeType: 'application/octet-stream', packageName: 'app.receiver' };
for (const scenario of ['success', 'wrong-receipt', 'lost-dispatch-response']) test(`multi-file share ${scenario} preserves delivery boundary`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'appvanta-multi-share-'));
  const commands = []; let operation, accepted = 0, state = 'prepared';
  const execute = async args => {
    commands.push(args);
    if (args.includes('pm')) return 'package:/helper.apk';
    if (args.includes('start')) {
      operation = args[args.indexOf('operation') + 1];
      const mode = args[args.indexOf('mode') + 1];
      if (mode === 'prepare') accepted++;
      if (mode === 'cancel') state = 'cancelled';
      if (mode === 'dispatch') { state = 'dispatched'; if (scenario === 'lost-dispatch-response') throw new Error('Connection lost after delivery'); }
      return 'Status: ok';
    }
    return JSON.stringify({ version: 1, operation, state, count: 2, mimeType: action.mimeType, packageName: action.packageName,
      uris: scenario === 'wrong-receipt' && state === 'prepared' ? ['content://wrong/a'] : action.uris.slice(0, accepted) });
  };
  try {
    if (scenario === 'success') await shareFiles(action, directory, execute, execute);
    else await assert.rejects(shareFiles(action, directory, execute, execute), /Multi-attachment share failed/);
    const dispatches = commands.filter(args => args.includes('dispatch'));
    const isolated = commands.filter(args => args.includes('-f'));
    assert.equal(isolated.length, 1);
    assert.equal(isolated[0][isolated[0].indexOf('-f') + 1], '0x18000000');
    assert.equal(isolated[0][isolated[0].indexOf('index') + 1], '0');
    assert.equal(dispatches.length, scenario === 'wrong-receipt' ? 0 : 1);
    assert.equal(commands.filter(args => args.includes('cancel')).length, scenario === 'wrong-receipt' ? 1 : 0);
    const files = await readdir(directory);
    if (scenario === 'success') assert(files.some(name => name.endsWith('-dispatched.json')));
    else {
      const failure = JSON.parse(await readFile(join(directory, files.find(name => name.endsWith('-failure.json'))), 'utf8'));
      assert.equal(failure.dispatchAttempted, scenario === 'lost-dispatch-response');
      assert.equal(failure.cancellation.attempted, scenario === 'wrong-receipt');
      if (scenario === 'wrong-receipt') assert.equal(failure.cancellation.receipt.state, 'cancelled');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('multi-file share rejects invalid URI lists before contacting device', async () => {
  for (const uris of [[], ['content://a/b'], ['content://a/b', 'content://a/b'], ['file:///a', 'content://a/b'], Array.from({ length: 17 }, (_, i) => `content://a/${i}`)]) {
    let calls = 0;
    const execute = async () => { calls++; return ''; };
    await assert.rejects(shareFiles({ ...action, uris }, 'unused', execute, execute)); assert.equal(calls, 0);
  }
});
