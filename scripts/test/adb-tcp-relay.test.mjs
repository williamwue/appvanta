import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { createAdbTcpRelay } from '../adb-tcp-relay.mjs';

test('relay diagnostics retain the most recent bounded connections', async () => {
  const sockets = new Set();
  const upstream = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.end('x');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const relay = await createAdbTcpRelay(upstream.address().port);
  try {
    for (let i = 0; i < 260; i++) {
      const client = connect(Number(relay.environment.ADB_SERVER_SOCKET.split(':').at(-1)), '127.0.0.1');
      try { const ended = once(client, 'end', { signal: AbortSignal.timeout(5000) }); client.resume(); await ended; }
      finally { client.destroy(); }
    }
    assert.equal(relay.diagnostics.length, 256);
    assert.equal(relay.diagnostics[0].sequence, 5);
    assert.equal(relay.diagnostics.at(-1).sequence, 260);
    assert.equal(relay.diagnostics.at(-1).receivedBytes, 1);
  } finally {
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(done => upstream.close(done));
  }
});

test('relay drains the final upstream bytes before ending a slow client', async () => {
  const payload = Buffer.alloc(8 * 1024 * 1024 + 123, 0xa5);
  const sockets = new Set();
  const upstream = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => socket.end(payload));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const relay = await createAdbTcpRelay(upstream.address().port);
  const client = connect(Number(relay.environment.ADB_SERVER_SOCKET.split(':').at(-1)), '127.0.0.1');
  const chunks = []; client.on('data', chunk => chunks.push(chunk));
  let timer;
  try {
    await once(client, 'connect'); client.pause();
    const ended = once(client, 'end', { signal: AbortSignal.timeout(5000) });
    client.write('request'); timer = setTimeout(() => client.resume(), 200);
    await ended;
    assert.deepEqual(Buffer.concat(chunks), payload);
  } finally {
    clearTimeout(timer); client.destroy(); await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(done => upstream.close(done));
  }
});

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
    assert.equal(relay.diagnostics[0].target, '/sdcard/empty.mp4');
    assert.equal(relay.diagnostics[0].receivedBytes, done.length);
    assert.equal(relay.diagnostics[0].responsePrefixHex, done.toString('hex'));
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
