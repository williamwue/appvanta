import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { protocolSession, ParameterError } from '../../packages/mcp/dist/protocol.js';

const init = { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
test('MCP initialization, notification silence and error categories preserve request IDs', async () => {
  let calls = 0;
  const handle = protocolSession([], async (name) => {
    calls++;
    if (name === 'bad') throw new ParameterError('invalid');
    throw new Error('device offline');
  });
  const request = async (method, params, id = 1) => handle(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
  assert.equal((await handle('{bad')).error.code, -32700);
  for (const item of [null, [], {}, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }]) assert.equal((await handle(JSON.stringify(item))).error.code, -32600);
  assert.equal((await request('tools/list')).error.code, -32002);
  assert.equal((await request('initialize', {})).error.code, -32602);
  assert.deepEqual((await request('ping', {}, 0)).result, {});
  assert.equal((await handle(JSON.stringify(init))).result.protocolVersion, '2024-11-05');
  assert.equal((await request('tools/list')).error.code, -32002);
  assert.equal(await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), undefined);
  assert.equal((await request('tools/list')).result.tools.length, 0);
  assert.equal((await request('tools/list', { cursor: 'invalid' })).error.code, -32602);
  assert.equal((await request('initialize', init.params)).error.code, -32600);
  assert.equal((await request('unknown')).error.code, -32601);
  assert.equal((await request('tools/call', { name: 'bad' }, 'bad-id')).id, 'bad-id');
  assert.equal((await request('tools/call', { name: 'bad' })).error.code, -32602);
  const offline = await request('tools/call', { name: 'offline' });
  assert.equal(offline.result.isError, true);
  assert.equal(JSON.parse(offline.result.content[0].text).error, 'device offline');
  const count = calls;
  for (const method of ['unknown-notification', 'tools/call', 'initialize']) assert.equal(await handle(JSON.stringify({ jsonrpc: '2.0', method, params: { name: 'offline' } })), undefined);
  assert.equal(calls, count);
});

test('stdio survives malformed input and returns tool execution errors as content', () => {
  const lines = ['{bad', JSON.stringify(init), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 'tool', method: 'tools/call', params: { name: 'record_flow', arguments: { runDirectory: 'appvanta-nonexistent-protocol-fixture' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'ping' })];
  const result = spawnSync(process.execPath, ['packages/mcp/dist/index.js'], { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 4);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses.find(item => item.id === 'tool').result.isError, true);
  assert.deepEqual(responses.find(item => item.id === 'ping'), { jsonrpc: '2.0', id: 'ping', result: {} });
});

test('in-flight cancellation is responsive, type-sensitive and suppresses the cancelled response', async () => {
  let stopped = false;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const handle = protocolSession([], async (_, args, signal) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true }));
  });
  await handle(JSON.stringify(init));
  await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const request = { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'long' } };
  const pending = handle(JSON.stringify(request));
  await ready;
  assert.equal((await handle(JSON.stringify(request))).error.code, -32600);
  const ping = await handle(JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'ping' }));
  assert.deepEqual(ping.result, {});
  await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: '42' } }));
  assert.equal(stopped, false);
  assert.equal(await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42, reason: 'test cancel' } })), undefined);
  assert.equal(await pending, undefined);
  assert.equal(stopped, true);
  assert.equal(await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } })), undefined);
});
