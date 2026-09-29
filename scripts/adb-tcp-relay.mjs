import { createServer, connect } from 'node:net';

export async function createAdbTcpRelay(upstreamPort = 5037) {
  const sockets = new Set();
  const connections = [];
  let offline = false;
  let pullTargets, interruptedPull;
  const relay = createServer(client => {
    if (offline) { client.destroy(); return; }
    const server = connect({ host: '127.0.0.1', port: upstreamPort });
    const diagnostic = { receivedBytes: 0, responsePrefixHex: '', target: null, closed: false };
    if (connections.length < 256) connections.push(diagnostic);
    server.on('error', error => { diagnostic.error = String(error); });
    server.on('close', () => { diagnostic.closed = true; });
    for (const socket of [client, server]) {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    }
    client.on('error', () => server.destroy()); server.on('error', () => client.destroy());
    let endingInterruptedPull = false;
    client.on('close', () => server.destroy());
    server.on('close', () => { if (!endingInterruptedPull) client.destroy(); });
    let request = Buffer.alloc(0), response = Buffer.alloc(0), target;
    client.on('data', chunk => {
      if (!pullTargets || target) return;
      request = Buffer.concat([request, chunk]).subarray(-65536);
      if (request.includes(Buffer.from('RECV')) || request.includes(Buffer.from('RCV2'))) {
        target = pullTargets.find(path => request.includes(Buffer.from(path)));
        if (target) diagnostic.target = target;
      }
    });
    client.pipe(server);
    client.on('drain', () => server.resume());
    server.on('data', chunk => {
      diagnostic.receivedBytes += chunk.length;
      if (diagnostic.responsePrefixHex.length < 64) diagnostic.responsePrefixHex += chunk.subarray(0, (64 - diagnostic.responsePrefixHex.length) / 2).toString('hex');
      if (target && !interruptedPull) {
        response = Buffer.concat([response, chunk]);
        const data = response.indexOf(Buffer.from('DATA'));
        if (data < 0) {
          let pending = Math.min(3, response.length);
          while (pending && !response.subarray(-pending).equals(Buffer.from('DATA').subarray(0, pending))) pending--;
          const ready = response.subarray(0, response.length - pending);
          if (ready.length && !client.write(ready)) server.pause();
          response = response.subarray(response.length - pending);
          return;
        }
        if (response.length <= data + 8) return;
        const frameBytes = response.readUInt32LE(data + 4);
        if (frameBytes < 2) { client.write(response); response = Buffer.alloc(0); return; }
        interruptedPull = { remote: target, frameBytes, deliveredPayloadBytes: 1 };
        offline = true; pullTargets = undefined;
        endingInterruptedPull = true;
        for (const socket of sockets) if (socket !== client) socket.destroy();
        client.end(response.subarray(0, data + 9));
        return;
      }
      if (!client.write(chunk)) server.pause();
    });
  });
  await new Promise((done, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', done); });
  return {
    environment: { ...process.env, ADB_SERVER_SOCKET: `tcp:127.0.0.1:${relay.address().port}` },
    setOffline(value) { offline = value; if (offline) for (const socket of sockets) socket.destroy(); },
    interruptNextPull(paths) { pullTargets = [...paths]; interruptedPull = undefined; },
    get interruptedPull() { return interruptedPull; },
    get diagnostics() { return connections.map(connection => ({ ...connection })); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(done => relay.close(done)); },
  };
}
