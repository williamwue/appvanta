import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readMcpResponses } from './mcp-response-reader.mjs';

const device = process.argv[2]; assert(device);
const nested = process.argv[3] === 'nested';
const root = resolve('.appvanta/runs', `flow-branch-${Date.now()}`); await mkdir(root, { recursive: true });
const when = { kind: 'app-running', packageName: `dev.appvanta.absent${randomUUID().replaceAll('-', '')}` };
const branch = equals => ({ key: 'absent', when, equals });
let flow = { name: 'Single decision branch', steps: [
  { description: 'Then first', branch: branch(true), action: { kind: 'button', button: 'home' } },
  { description: 'Then second', branch: branch(true), action: { kind: 'button', button: 'back' } },
  { description: 'Else first', branch: branch(false), echo: 'Selected else' },
  { description: 'Else second', branch: branch(false), echo: 'Same decision' },
] };
if (nested) {
  const template = JSON.parse(await readFile('docs/templates/branch.json', 'utf8'));
  template.variables.missingApp = when.packageName;
  await writeFile(join(root, 'template.json'), JSON.stringify(template, null, 2));
  const compiled = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'compile-flow', join(root, 'template.json'), join(root, 'compiled.json')], { timeout: 30000, windowsHide: true })).stdout);
  assert.equal(compiled.status, 'compiled');
  flow = JSON.parse(await readFile(join(root, 'compiled.json'), 'utf8'));
  assert(flow.steps[0].branch.parents.length === 1);
}
await writeFile(join(root, 'flow.json'), JSON.stringify(flow, null, 2));
const verify = async result => {
  assert.equal(result.status, 'passed'); assert.equal(result.cleanupFailed, false);
  assert.deepEqual(result.steps.map(step => step.status), nested ? ['skipped', 'passed', 'passed', 'skipped'] : ['skipped', 'skipped', 'passed', 'passed']);
  assert.deepEqual(result.steps.map(step => step.branchMatched), nested ? [false, true, true, false] : [false, false, true, true]);
  const decision = JSON.parse(await readFile(join(result.runDirectory, nested ? 'branch-template_branch_2.json' : 'branch-absent.json'), 'utf8'));
  assert.equal(decision.matched, false); assert.equal(decision.source, 'observed'); assert.deepEqual(decision.condition, when);
  if (nested) {
    const outer = JSON.parse(await readFile(join(result.runDirectory, 'branch-template_branch_1.json'), 'utf8'));
    assert.equal(outer.matched, true); assert.equal(outer.source, 'observed');
    assert.deepEqual(result.steps.filter(step => step.output).map(step => step.output), ['System UI is running; missing app is absent', 'Both decisions are reused']);
  }
  assert.equal((await readFile(join(result.runDirectory, 'actions.jsonl'), 'utf8')).trim(), '');
  return result;
};
const run = await verify(JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'run-flow', device, join(root, 'flow.json')], { timeout: 120000, windowsHide: true })).stdout));
console.log('CLI branch passed');
const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let mcp;
try {
  const responses = readMcpResponses(child.stdout, [1, 2, 3], 120000);
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'branch-verifier', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_flow', arguments: { deviceId: device, flow } } },
  ]) child.stdin.write(JSON.stringify(message) + '\n');
  const messages = await responses;
  assert(messages.find(message => message.id === 2).result.tools.find(tool => tool.name === 'run_flow').inputSchema.$defs.step.properties.branch);
  const response = messages.find(message => message.id === 3).result;
  assert.notEqual(response.isError, true, JSON.stringify(response));
  mcp = await verify(JSON.parse(response.content[0].text));
} finally {
  if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, nested, flow, run, mcp }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
