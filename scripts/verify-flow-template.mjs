import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseFlow } from '../packages/core/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const root = resolve('.appvanta/runs', `flow-template-${Date.now()}`);
await mkdir(root, { recursive: true });
const output = join(root, 'compiled.json');
const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true })).stdout);
const compiled = await cli('compile-flow', 'docs/templates/markor.json', output);
assert.equal(compiled.status, 'compiled');
const bytes = await readFile(output, 'utf8'), flow = parseFlow(JSON.parse(bytes));
assert.equal(flow.steps[0].launchPackage, 'net.gsantner.markor');
assert.equal(flow.steps[0].action.timeoutMs, 10000);
assert(!Object.hasOwn(flow, 'variables') && !Object.hasOwn(flow, 'fragments'));
await assert.rejects(cli('compile-flow', 'docs/templates/markor.json', output), /EEXIST/);
assert.equal(await readFile(output, 'utf8'), bytes);
let run, mcp;
if (process.argv[2]) {
  run = await cli('run-flow', process.argv[2], output);
  assert.equal(run.status, 'passed'); assert.equal(run.cleanupFailed, false);
  assert.deepEqual(run.steps.map(step => step.status), ['passed', 'skipped', 'passed']);
  assert.equal(run.steps[1].conditionMatched, false);
  assert.equal(run.steps[2].conditionMatched, true);
  assert.deepEqual(JSON.parse(await readFile(join(run.runDirectory, 'flow.json'), 'utf8')), flow);
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const responses = readMcpResponses(child.stdout, [1, 2, 3], 120000);
    for (const message of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'conditional-flow-verifier', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_flow', arguments: { deviceId: process.argv[2], flow } } },
    ]) child.stdin.write(JSON.stringify(message) + '\n');
    const messages = await responses;
    const tool = messages.find(message => message.id === 2).result.tools.find(tool => tool.name === 'run_flow');
    assert(tool.inputSchema.$defs.step.properties.when);
    const response = messages.find(message => message.id === 3).result;
    assert.notEqual(response.isError, true, JSON.stringify(response));
    mcp = JSON.parse(response.content[0].text);
    assert.equal(mcp.status, 'passed'); assert.equal(mcp.cleanupFailed, false);
    assert.deepEqual(mcp.steps.map(step => step.status), ['passed', 'skipped', 'passed']);
    assert.deepEqual(JSON.parse(await readFile(join(mcp.runDirectory, 'flow.json'), 'utf8')), flow);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  }
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', compiled, flow, existingOutputPreserved: true, run, mcp }, null, 2));
console.log(JSON.stringify({ status: 'passed', root, deviceExecuted: !!run }));
