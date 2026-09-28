import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('MCP stores project state under APPVANTA_PROJECT_ROOT', async () => {
  const launchRoot = await mkdtemp(join(tmpdir(), 'appvanta-mcp-launch-'));
  const projectRoot = await mkdtemp(join(tmpdir(), 'appvanta-mcp-project-'));
  const child = spawn(process.execPath, [resolve('packages/mcp/dist/index.js')], {
    cwd: launchRoot,
    env: { ...process.env, APPVANTA_PROJECT_ROOT: projectRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
    const deadline = Date.now() + 5000;
    while (!output.split('\n').some(line => line.includes('"id":2'))) {
      if (Date.now() > deadline) throw new Error(`MCP response timeout: ${output}`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
    }
    assert.equal((await stat(join(projectRoot, '.appvanta', 'tasks'))).isDirectory(), true);
    const response = output.split('\n').filter(Boolean).map(JSON.parse).find(value => value.id === 2);
    assert.equal(response.result.isError, undefined);
    await assert.rejects(stat(join(launchRoot, '.appvanta')));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await Promise.all([rm(launchRoot, { recursive: true, force: true }), rm(projectRoot, { recursive: true, force: true })]);
  }
});
