import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withDeviceLock, inspectDeviceLock } from '../packages/core/dist/index.js';
import { AdbDriver } from '../packages/android/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const device = process.argv[2]; assert(device);
const directory = resolve('.appvanta/runs', `share-helper-${Date.now()}`); await mkdir(directory, { recursive: true });
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', device, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 })).stdout;
const source = 'dev.appvanta.share.source', receiver = 'dev.appvanta.share.receiver', helper = 'dev.appvanta.share.helper';
const driver = new AdbDriver({ artifactsDirectory: join(directory, 'observations') });
const tokens = [randomUUID(), randomUUID()], uris = tokens.map(token => `content://${source}/payload/${token}`);
const waitText = text => driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text }, timeoutMs: 15000 });
const request = async (operation, mode, index) => adb('shell', 'am', 'start', '-W', '-n', `${helper}/.ShareActivity`, '--es', 'operation', operation, '--es', 'mode', mode,
  ...(mode === 'prepare' ? ['--ei', 'index', String(index), '--ei', 'count', '2', '--es', 'mimeType', 'application/octet-stream', '--es', 'targetPackage', receiver, '-d', uris[index], '--grant-read-uri-permission'] : []));
const receiptRaw = operation => adb('exec-out', 'content', 'read', '--uri', `content://${helper}/operations/${operation}`);
const noDelivery = () => adb('shell', 'run-as', receiver, 'test', '!', '-e', 'files/received.json');
const receipts = []; const prepared = []; const product = [];
let expectedReport;
try {
  await withDeviceLock(device, async () => {
    for (const fixture of ['share-source', 'share-receiver', 'share-helper']) await adb('install', '-r', resolve(`.appvanta/${fixture}/appvanta-${fixture}.apk`));
    await driver.stopApp(device, receiver); await driver.stopApp(device, helper); await driver.stopApp(device, source);
    await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
    for (const [index, token] of tokens.entries()) {
      await adb('shell', 'am', 'start', '-W', '-n', `${source}/.SourceActivity`, '--es', 'token', token, '--ei', 'seed', String(index));
      prepared.push(token); await waitText(`Ready ${token}`);
    }
    const interrupted = randomUUID();
    await request(interrupted, 'prepare', 0); await waitText(`Prepared ${interrupted} 1`);
    const before = await receiptRaw(interrupted); assert.equal(JSON.parse(before).state, 'prepared');
    await driver.stopApp(device, helper);
    await request(interrupted, 'prepare', 1); await waitText('Preparation must start at zero'); await noDelivery();
    assert.equal(await receiptRaw(interrupted), before);
    await request(interrupted, 'prepare', 0); await waitText('Operation already exists'); await noDelivery();
    assert.equal(await receiptRaw(interrupted), before); receipts.push({ scenario: 'lost-preparation-replay-refused', receipt: JSON.parse(before), unchanged: true });
    await driver.stopApp(device, helper);
    const cancelled = randomUUID();
    await request(cancelled, 'prepare', 0); await waitText(`Prepared ${cancelled} 1`);
    await request(cancelled, 'cancel');
    const cancellation = JSON.parse(await receiptRaw(cancelled)); assert.equal(cancellation.state, 'cancelled'); await noDelivery();
    receipts.push({ scenario: 'cancelled', receipt: cancellation });
    const operation = randomUUID();
    for (let index = 0; index < 2; index++) { await request(operation, 'prepare', index); await waitText(`Prepared ${operation} ${index + 1}`); }
    const ready = JSON.parse(await receiptRaw(operation));
    assert.equal(ready.version, 1); assert.equal(ready.state, 'prepared'); assert.deepEqual(ready.uris, uris); await noDelivery();
    await request(operation, 'dispatch'); await waitText('received');
    const sentRaw = await receiptRaw(operation), sent = JSON.parse(sentRaw);
    assert.equal(sent.state, 'dispatched'); assert.equal(sent.operation, operation); assert.deepEqual(sent.uris, uris); assert.equal(sent.count, 2);
    assert.equal(sent.packageName, receiver); assert.equal(sent.mimeType, 'application/octet-stream');
    const report = JSON.parse(await adb('exec-out', 'run-as', receiver, 'cat', 'files/received.json'));
    expectedReport = report;
    await writeFile(join(directory, 'received.json'), JSON.stringify(report, null, 2));
    assert.equal(report.status, 'received'); assert.equal(report.clipCount, 2); assert.equal(report.items.length, 2);
    for (const [index, item] of report.items.entries()) {
      assert.equal(item.uri, uris[index]); assert.equal(item.bytes, 4096); assert.equal(item.readPermission, 0); assert.equal(item.writeDenied, true);
      assert.equal(item.flags & 1, 1); assert.equal(item.flags & 2, 0);
      assert.equal(item.sha256, createHash('sha256').update(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + index) & 255))).digest('hex'));
    }
    await driver.stopApp(device, helper); await driver.stopApp(device, receiver);
    await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
    await request(operation, 'prepare', 0); await waitText('Operation already exists'); await noDelivery();
    assert.equal(await receiptRaw(operation), sentRaw); receipts.push({ scenario: 'dispatched-replay-refused', receipt: sent, unchanged: true });
    await driver.stopApp(device, helper);
  });
    const flow = { name: 'Product multi-attachment delivery', steps: [
      { description: 'Send two attachments', action: { kind: 'share-files', uris, mimeType: 'application/octet-stream', packageName: receiver } },
      { description: 'Receiver delivery', assertText: 'received' },
    ] };
    const flowPath = join(directory, 'flow.json'); await writeFile(flowPath, JSON.stringify(flow));
    for (const transport of ['cli', 'mcp']) {
      await withDeviceLock(device, async () => { await driver.stopApp(device, receiver); await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json'); });
      let result;
      if (transport === 'cli') result = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'run-flow', device, flowPath], { encoding: 'utf8', windowsHide: true, timeout: 120000 })).stdout);
      else {
        const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
        try {
          const ready = readMcpResponses(child.stdout, [1]);
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'multi-share-verifier', version: '1' } } }) + '\n'); await ready;
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          const pending = readMcpResponses(child.stdout, [2], 120000);
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_flow', arguments: { deviceId: device, flow } } }) + '\n');
          const response = (await pending).find(item => item.id === 2);
          assert(response?.result && !response.result.isError, JSON.stringify({ response, stderr })); result = JSON.parse(response.result.content[0].text);
        } finally { child.kill(); await exited; }
      }
      assert.equal(result.status, 'passed');
      const delivered = JSON.parse(await adb('exec-out', 'run-as', receiver, 'cat', 'files/received.json'));
      assert.deepEqual(delivered.items, expectedReport.items); assert.equal(delivered.status, 'received'); assert.equal(delivered.clipCount, 2);
      product.push({ transport, result, report: delivered });
    }
  await withDeviceLock(device, async () => {
    await driver.stopApp(device, receiver); await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
    for (const token of tokens) {
      await driver.stopApp(device, source);
      await adb('shell', 'am', 'start', '-W', '-n', `${source}/.SourceActivity`, '--es', 'token', token, '--ez', 'cleanup', 'true');
      await waitText(`Removed ${token}`); await adb('shell', 'run-as', source, 'test', '!', '-e', `files/${token}.bin`);
    }
    await driver.stopApp(device, source);
  });
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'passed', device, tokens, receipts, product, fixturesRemoved: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), tokens, prepared, receipts, product, lease: await inspectDeviceLock(device) }, null, 2)); throw error;
}
