import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withDeviceLock, inspectDeviceLock } from '../packages/core/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const device = process.argv[2]; assert(device);
const root = resolve('.appvanta/runs', `managed-upload-${Date.now()}`); await mkdir(root, { recursive: true });
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', device, ...args], { windowsHide: true, timeout: 20000, encoding: 'utf8' })).stdout;
const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', ...args], { windowsHide: true, timeout: 120000, encoding: 'utf8' })).stdout);
const mcp = async (name, args) => {
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  try {
    const ready = readMcpResponses(child.stdout, [1]);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'upload-verifier', version: '1' } } }) + '\n'); await ready;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const pending = readMcpResponses(child.stdout, [2], 120000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const response = (await pending).find(item => item.id === 2);
    assert(response?.result && !response.result.isError, JSON.stringify({ response, stderr }));
    return JSON.parse(response.result.content[0].text);
  } finally { child.kill(); await exited; }
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 255));
const local = join(root, 'input.bin'), empty = join(root, 'empty.bin');
await writeFile(local, bytes); await writeFile(empty, Buffer.alloc(0));
const uploads = [], interruptions = [];
let flowResult;
try {
  await withDeviceLock(device, async () => {
    for (const fixture of ['share-helper', 'share-receiver']) await adb('install', '-r', resolve(`.appvanta/${fixture}/appvanta-${fixture}.apk`));
    await adb('shell', 'am', 'force-stop', 'dev.appvanta.share.receiver');
    await adb('shell', 'run-as', 'dev.appvanta.share.receiver', 'rm', '-f', 'files/received.json');
  });
  uploads.push(await cli('upload-attachment', device, local, 'application/octet-stream', "本地 'payload.bin"));
  uploads.push(await mcp('upload_attachment', { deviceId: device, localFile: empty, mimeType: 'application/octet-stream', displayName: 'empty.bin' }));
  for (const [index, upload] of uploads.entries()) {
    assert.equal(upload.shared, false); assert.equal(upload.scope, 'uploaded-only'); assert.equal(upload.receipt.state, 'ready');
    assert.equal(upload.receipt.size, index === 0 ? 4096 : 0); assert.equal(upload.receipt.sha256, sha(index === 0 ? bytes : Buffer.alloc(0)));
    assert.deepEqual(await readFile(join(upload.recordDirectory, 'payload.bin')), index === 0 ? bytes : Buffer.alloc(0));
    await adb('shell', 'test', '!', '-d', `/data/local/tmp/appvanta-upload-${upload.id}`);
    assert.equal(await inspectDeviceLock(device), null);
  }
  assert.deepEqual((await cli('inspect-upload', device, uploads[0].id)).receipt, uploads[0].receipt);
  assert.deepEqual((await mcp('inspect_upload', { deviceId: device, id: uploads[1].id })).receipt, uploads[1].receipt);
  const flow = { name: 'Share client uploads', steps: [{ description: 'Send uploaded files', action: { kind: 'share-files', uris: uploads.map(item => item.uri), mimeType: 'application/octet-stream', packageName: 'dev.appvanta.share.receiver' } }, { description: 'Received content', assertText: 'received' }] };
  const flowPath = join(root, 'flow.json'); await writeFile(flowPath, JSON.stringify(flow));
  flowResult = await cli('run-flow', device, flowPath); assert.equal(flowResult.status, 'passed');
  const delivered = JSON.parse(await adb('exec-out', 'run-as', 'dev.appvanta.share.receiver', 'cat', 'files/received.json'));
  await writeFile(join(root, 'received.json'), JSON.stringify(delivered, null, 2));
  assert.equal(delivered.items.length, 2);
  for (const [index, item] of delivered.items.entries()) {
    assert.equal(item.uri, uploads[index].uri); assert.equal(item.bytes, uploads[index].receipt.size); assert.equal(item.sha256, uploads[index].receipt.sha256);
    assert.equal(item.readPermission, 0); assert.equal(item.writeDenied, true);
  }
  assert.equal((await cli('delete-upload', device, uploads[0].id)).deleted, true);
  assert.equal((await mcp('delete_upload', { deviceId: device, id: uploads[1].id })).deleted, true);
  for (const upload of uploads) assert.equal((await cli('inspect-upload', device, upload.id)).receipt.state, 'deleted');
  await withDeviceLock(device, async () => {
    await adb('shell', 'am', 'force-stop', 'dev.appvanta.share.receiver');
    await adb('shell', 'run-as', 'dev.appvanta.share.receiver', 'rm', '-f', 'files/received.json');
  });
  for (const phase of ['pushed', 'ready-response']) {
    const code = `import {mock} from 'node:test';import * as childProcess from 'node:child_process';import {promisify} from 'node:util';import {dirname} from 'node:path';
const real=promisify(childProcess.execFile);let directory;
mock.module('node:child_process',{namedExports:{...childProcess,execFile:(file,args,options,callback)=>{real(file,args,options).then(result=>{
 if(args.includes('push')) directory=dirname(args[args.indexOf('push')+1]);
 if((${JSON.stringify(phase)}==='pushed'&&args.includes('push'))||(${JSON.stringify(phase)}==='ready-response'&&args.includes('query')&&result.stdout.includes('state=ready'))){process.send({directory});setInterval(()=>{},1000);return;}
 callback(null,result);
},error=>callback(error));}}});
const {uploadAndroidAttachment}=await import(${JSON.stringify(new URL('../packages/android/dist/managed-upload.js', import.meta.url).href)});
await uploadAndroidAttachment(${JSON.stringify(device)},${JSON.stringify(local)},'application/octet-stream',{directory:${JSON.stringify(root)},adbPath:${JSON.stringify(process.env.ADB_PATH ?? 'adb')}});throw new Error('Expected interruption');`;
    const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    let message, exit;
    try {
      [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(90000) }), exited.then(() => { throw new Error(stderr); })]);
      child.kill('SIGKILL'); exit = await exited;
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
    assert.equal(exit[1], 'SIGKILL');
    const requestRaw = await readFile(join(message.directory, 'request.json'), 'utf8'), request = JSON.parse(requestRaw);
    const state = await inspectDeviceLock(device); assert.equal(state.owner, 'dead'); assert.equal(state.lease.pid, child.pid);
    const before = await cli('inspect-upload', device, request.id);
    assert.equal(before.receipt.state, phase === 'pushed' ? 'prepared' : 'ready');
    await assert.rejects(cli('recover-upload', device, randomUUID()));
    assert.deepEqual((await inspectDeviceLock(device)).lease, state.lease);
    const result = await cli('recover-upload', device, state.lease.token);
    assert.equal(result.resumed, false); assert.equal(result.shared, false);
    assert.equal((await cli('inspect-upload', device, request.id)).receipt.state, 'deleted');
    assert.equal(await inspectDeviceLock(device), null);
    await adb('shell', 'test', '!', '-d', `/data/local/tmp/appvanta-upload-${request.id}`);
    await adb('shell', 'run-as', 'dev.appvanta.share.receiver', 'test', '!', '-e', 'files/received.json');
    assert.equal(await readFile(join(message.directory, 'request.json'), 'utf8'), requestRaw);
    interruptions.push({ phase, pid: child.pid, exit, request, before, result, retainedToken: state.lease.token });
  }
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, uploads, flowResult, interruptions }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), device, uploads, flowResult, interruptions, lease: await inspectDeviceLock(device) }, null, 2)); throw error;
}
