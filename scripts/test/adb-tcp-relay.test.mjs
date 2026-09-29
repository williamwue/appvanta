import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { createAdbTcpRelay } from '../adb-tcp-relay.mjs';

test('targeted pull forwards a DONE response when there is no DATA frame', async () => {
  const sockets = new Set();
  const done = Buffer.from('444f4e4500000000', 'hex');
  const upstream = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => socket.write(done));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const relay = await createAdbTcpRelay(upstream.address().port);
  relay.interruptNextPull(['/sdcard/empty.mp4']);
  const client = connect(Number(relay.environment.ADB_SERVER_SOCKET.split(':').at(-1)), '127.0.0.1');
  try {
    await once(client, 'connect');
    const received = once(client, 'data', { signal: AbortSignal.timeout(1000) });
    client.write(Buffer.from('RECV/sdcard/empty.mp4'));
    assert.deepEqual((await received)[0], done);
    assert.equal(relay.interruptedPull, undefined);
  } finally {
    client.destroy(); await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(done => upstream.close(done));
  }
});

test('targeted pull truncates DATA after a forwarded reply and a split frame header', async () => {
  const sockets = new Set();
  const frame = Buffer.concat([Buffer.from('DATA'), Buffer.from([4, 0, 0, 0]), Buffer.from('abcd')]);
  const upstream = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      socket.write(Buffer.from('OKAYDA'));
      setTimeout(() => { if (!socket.destroyed) socket.write(frame.subarray(2)); }, 20);
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const relay = await createAdbTcpRelay(upstream.address().port);
  relay.interruptNextPull(['/sdcard/capture.mp4']);
  const client = connect(Number(relay.environment.ADB_SERVER_SOCKET.split(':').at(-1)), '127.0.0.1');
  const chunks = []; client.on('data', chunk => chunks.push(chunk));
  try {
    await once(client, 'connect');
    const ended = once(client, 'end', { signal: AbortSignal.timeout(1000) });
    client.write(Buffer.from('RECV/sdcard/capture.mp4')); await ended;
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from('OKAY'), frame.subarray(0, 9)]));
    assert.deepEqual(relay.interruptedPull, { remote: '/sdcard/capture.mp4', frameBytes: 4, deliveredPayloadBytes: 1 });
  } finally {
    client.destroy(); await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(done => upstream.close(done));
  }
});
