import { createInterface } from 'node:readline';

export async function readMcpResponses(stream, ids, timeoutMs = 10000) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const pending = new Set(ids);
  const messages = [];
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.removeAllListeners();
      stream.off('error', onError);
      lines.close();
      if (error) reject(error);
      else resolve(messages);
    };
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error(`MCP response timeout; missing IDs: ${[...pending].join(', ')}`)), timeoutMs);
    stream.on('error', onError);
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { finish(new Error('MCP returned an invalid JSON response')); return; }
      messages.push(message);
      if (message && typeof message === 'object') pending.delete(message.id);
      if (!pending.size) finish();
    });
    lines.on('close', () => finish(new Error(`MCP output closed; missing IDs: ${[...pending].join(', ')}`)));
  });
}
