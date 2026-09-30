import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readMcpResponses } from './mcp-response-reader.mjs';

export async function verifyShareReceiptClients(device, operation, raw) {
  const expected = { scope: 'read-only', resumeAuthorized: false, receipt: JSON.parse(raw), receiptSha256: createHash('sha256').update(raw).digest('hex') };
  const cli = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'inspect-attachment-share', device, operation], { encoding: 'utf8', windowsHide: true, timeout: 30000 })).stdout);
  assert.deepEqual(cli, expected);
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const ready = readMcpResponses(child.stdout, [1]);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'share-receipt-verifier', version: '1' } } }) + '\n'); await ready;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const pending = readMcpResponses(child.stdout, [2]);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inspect_attachment_share', arguments: { deviceId: device, operation } } }) + '\n');
    const response = (await pending).find(item => item.id === 2);
    assert(response?.result && !response.result.isError, JSON.stringify({ response, stderr }));
    const mcp = JSON.parse(response.result.content[0].text); assert.deepEqual(mcp, expected);
    return { operation, state: expected.receipt.state, cli, mcp };
  } finally { child.kill(); await exited; }
}
