import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const serial = process.argv[2];
assert(serial, 'Specify device serial');
const root = resolve('.appvanta/runs', `recording-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const exec = promisify(execFile);
const cli = async (...args) => JSON.parse((await exec(process.execPath, ['packages/cli/dist/index.js', ...args], { encoding: 'utf8', timeout: 180000 })).stdout);
const target = value => ({ kind: 'resource-id', value: `net.gsantner.markor:id/${value}` });
const source = { version: 1, name: 'Record Markor navigation', steps: [
  { description: 'Launch', launchPackage: 'net.gsantner.markor', assertTarget: target('nav_quicknote') },
  { description: 'Open files', action: { kind: 'tap', target: target('nav_notebook') }, assertTarget: target('nav_quicknote') },
  { description: 'Open QuickNote', action: { kind: 'tap', target: target('nav_quicknote') }, assertTarget: target('nav_notebook') },
] };
const input = join(root, 'source.json'), output = join(root, 'recorded.json');
await writeFile(input, JSON.stringify(source));
const original = await cli('run-flow', serial, input);
assert.equal(original.status, 'passed');
await cli('record-flow', original.runDirectory, output);
const recorded = JSON.parse(await readFile(output, 'utf8'));
assert.equal(recorded.steps.length, 6);
assert.deepEqual(recorded.steps.filter(step => step.action).map(step => step.action), source.steps.filter(step => step.action).map(step => step.action));
await assert.rejects(cli('record-flow', original.runDirectory, output));
const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: child.stdout });
let id = 0;
const pending = new Map();
lines.on('line', line => { const value = JSON.parse(line); const entry = pending.get(value.id); if (entry) { pending.delete(value.id); clearTimeout(entry.timer); value.error ? entry.reject(new Error(JSON.stringify(value.error))) : entry.resolve(value.result); } });
const rpc = (method, params) => new Promise((resolve, reject) => {
  const request = ++id;
  const timer = setTimeout(() => { pending.delete(request); reject(new Error(`Timeout: ${method}`)); }, 180000);
  pending.set(request, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: request, method, params }) + '\n');
});
try {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'recording-verifier', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const compile = await rpc('tools/call', { name: 'record_flow', arguments: { runDirectory: original.runDirectory } });
  assert.deepEqual(JSON.parse(compile.content[0].text), recorded);
  const result = await rpc('tools/call', { name: 'run_flow', arguments: { deviceId: serial, flow: recorded } });
  const replay = JSON.parse(result.content[0].text);
  assert.equal(replay.status, 'passed');
  for (const step of replay.steps) for (const file of step.evidence) await readFile(join(replay.runDirectory, file));
  await writeFile(join(root, 'verification.json'), JSON.stringify({ original: original.runDirectory, replay: replay.runDirectory, steps: replay.steps.length, mcpAndCliRecordingEqual: true, status: 'passed' }, null, 2));
  console.log(JSON.stringify({ root, status: 'passed' }));
} finally { child.kill(); lines.close(); for (const entry of pending.values()) clearTimeout(entry.timer); }
