import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readMcpResponses } from '../mcp-response-reader.mjs';

test('release reader waits for complete responses across byte and UTF-8 boundaries', async () => {
  const stream = new PassThrough();
  let settled = false;
  const result = readMcpResponses(stream, [1, 2]);
  result.then(() => { settled = true; });
  stream.write('{"id":1,"result":{}}\n{"id":2');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  for (const byte of Buffer.from(',"result":{"name":"中文"}}\n')) stream.write(Buffer.from([byte]));
  assert.deepEqual(await result, [{ id: 1, result: {} }, { id: 2, result: { name: '中文' } }]);
  stream.destroy();
});

test('release reader rejects truncated output, malformed JSON and missing response IDs', async () => {
  for (const mode of ['truncated', 'malformed', 'timeout']) {
    const stream = new PassThrough();
    const result = readMcpResponses(stream, [1, 2], 30);
    const rejection = assert.rejects(result, /invalid JSON|closed|timeout/);
    if (mode === 'truncated') stream.end('{"id":2');
    if (mode === 'malformed') stream.write('not-json\n');
    if (mode === 'timeout') stream.write('{"id":"2"}\n');
    await rejection;
    stream.destroy();
  }
});
