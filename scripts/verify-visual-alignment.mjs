import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PNG } from 'pngjs';
import { readMcpResponses } from './mcp-response-reader.mjs';

const root = resolve('.appvanta/runs', `visual-alignment-${Date.now()}`); await mkdir(root, { recursive: true });
const baseline = new PNG({ width: 32, height: 32 }), current = new PNG({ width: 32, height: 32 });
current.data.fill(255);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const i = (y * 32 + x) * 4;
  baseline.data[i] = (x * 31 + y * 17) % 256; baseline.data[i + 1] = (x * 13 + y * 47) % 256;
  baseline.data[i + 2] = (x * 73 + y * 19) % 256; baseline.data[i + 3] = 255;
}
for (let y = 0; y < 31; y++) for (let x = 0; x < 30; x++) baseline.data.copy(current.data, ((y + 1) * 32 + x + 2) * 4, (y * 32 + x) * 4, (y * 32 + x + 1) * 4);
const a = join(root, 'baseline.png'), b = join(root, 'current.png');
await writeFile(a, PNG.sync.write(baseline)); await writeFile(b, PNG.sync.write(current));
const cli = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'visual-diff', a, b, join(root, 'cli-diff.png'), '0', '0.1', '-', '3'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })).stdout);
const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let mcp;
try {
  const responses = readMcpResponses(child.stdout, [1, 2]);
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'alignment-verifier', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'compare_screenshots', arguments: { baselinePath: a, currentPath: b, diffPath: join(root, 'mcp-diff.png'), channelThreshold: 0, maxMismatchRatio: 0.1, maxAlignmentShift: 3 } } },
  ]) child.stdin.write(JSON.stringify(message) + '\n');
  const result = (await responses).find(message => message.id === 2).result;
  assert.notEqual(result.isError, true, JSON.stringify(result)); mcp = JSON.parse(result.content[0].text);
  for (const result of [cli, mcp]) {
    assert.equal(result.status, 'passed'); assert.equal(result.alignment.dx, 2); assert.equal(result.alignment.dy, 1);
    assert.equal(result.alignment.unmatchedPixels, 94); assert.equal(result.differentPixels, 94);
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', fixture: 'synthetic-translation', cli, mcp }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
