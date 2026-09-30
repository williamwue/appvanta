import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectAndroidProject } from '../../packages/android/dist/index.js';
import { mcpExchange } from './helpers/mcp-exchange.mjs';

test('SDK, CLI and actual MCP return the same project diagnosis and reject extra arguments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-project-clients-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'build.gradle.kts'), 'error("Never execute project code")');
  const log = join(root, 'failed-build.log');
  await writeFile(log, 'SDK location not found.\nBUILD FAILED in 1s\n');
  const expected = await inspectAndroidProject({ projectDirectory: root, buildLogPath: log });
  const cli = await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'inspect-project', root, log], { windowsHide: true });
  assert.deepEqual(JSON.parse(cli.stdout), expected);
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'project-test', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/call', params: { name: 'inspect_android_project', arguments: { projectDirectory: root, buildLogPath: log } } },
    { id: 3, method: 'tools/call', params: { name: 'inspect_android_project', arguments: { projectDirectory: root, execute: true } } },
    { id: 4, method: 'tools/call', params: { name: 'inspect_android_project', arguments: { projectDirectory: '' } } },
  ];
  const result = await mcpExchange(messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })), [1, 2, 3, 4]);
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.split('\n').map(line => JSON.parse(line));
  assert.deepEqual(JSON.parse(replies.find(message => message.id === 2).result.content[0].text), expected);
  for (const id of [3, 4]) assert.equal(replies.find(message => message.id === id).error.code, -32602);
});
