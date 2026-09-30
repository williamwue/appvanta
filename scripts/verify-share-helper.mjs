import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
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
const receipts = []; const prepared = []; const product = []; const interruptions = [];
const interruptHost = async phase => {
  const hostDirectory = join(directory, phase);
  const action = { kind: 'share-files', uris, mimeType: 'application/octet-stream', packageName: receiver };
  const code = `import {shareFiles} from ${JSON.stringify(new URL('../packages/android/dist/multi-file-share.js', import.meta.url).href)};
import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
const adb=async args=>(await promisify(execFile)(process.env.ADB_PATH??'adb',['-s',${JSON.stringify(device)},...args],{encoding:'utf8',windowsHide:true,timeout:20000})).stdout;
const pause=async operation=>{process.send({operation,phase:${JSON.stringify(phase)}});await new Promise(()=>setInterval(()=>{},1000));};
const execute=async args=>{
 const mode=args[args.indexOf('mode')+1]; const operation=args[args.indexOf('operation')+1];
 if(${JSON.stringify(phase)}==='prepared' && mode==='prepare' && args[args.indexOf('index')+1]==='1') await pause(operation);
 const result=await adb(args);
 if(${JSON.stringify(phase)}==='dispatch-response' && mode==='dispatch') {
  const deadline=Date.now()+10000;
  for(;;){const receipt=JSON.parse(await adb(['exec-out','content','read','--uri','content://dev.appvanta.share.helper/operations/'+operation]));if(receipt.state==='dispatched')break;if(Date.now()>deadline)throw new Error('Delivery receipt not observed');await new Promise(resolve=>setTimeout(resolve,50));}
  await pause(operation);
 }
 return result;
};
await shareFiles(${JSON.stringify(action)},${JSON.stringify(hostDirectory)},execute,adb);throw new Error('Expected host interruption');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(120000) }), exited.then(() => { throw new Error(stderr || 'Host exited before boundary'); })]);
    assert.equal(message.phase, phase); assert.match(message.operation, /^[a-f0-9-]{36}$/);
    child.kill('SIGKILL'); const exit = await exited;
    const files = await readdir(hostDirectory);
    const requestFile = `share-${message.operation}-request.json`;
    const saved = JSON.parse(await readFile(join(hostDirectory, requestFile), 'utf8'));
    assert.deepEqual(saved.action, action); assert.equal(saved.operation, message.operation);
    assert(!files.some(name => name.endsWith('-dispatched.json') || name.endsWith('-failure.json')));
    assert.equal(files.some(name => name.endsWith('-dispatch-intent.json')), phase === 'dispatch-response');
    if (phase === 'prepared') assert(files.some(name => name.endsWith('-prepared-1.json')));
    return { ...message, pid: child.pid, exit, hostDirectory, files };
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
};
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
    for (const phase of ['prepared', 'dispatch-response']) {
      await driver.stopApp(device, receiver); await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
      const killed = await interruptHost(phase);
      const raw = await receiptRaw(killed.operation), durable = JSON.parse(raw);
      assert.equal(durable.operation, killed.operation); assert.equal(durable.count, 2);
      assert.equal(durable.state, phase === 'prepared' ? 'prepared' : 'dispatched');
      assert.deepEqual(durable.uris, phase === 'prepared' ? uris.slice(0, 1) : uris);
      if (phase === 'prepared') {
        await noDelivery(); await request(killed.operation, 'cancel');
        assert.equal(JSON.parse(await receiptRaw(killed.operation)).state, 'cancelled'); await noDelivery();
      } else {
        const delivered = JSON.parse(await adb('exec-out', 'run-as', receiver, 'cat', 'files/received.json'));
        assert.deepEqual(delivered.items, expectedReport.items);
        await writeFile(join(directory, 'host-interrupted-delivery.json'), JSON.stringify(delivered, null, 2));
        await driver.stopApp(device, receiver); await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
        await request(killed.operation, 'prepare', 0); await waitText('Operation already exists'); await noDelivery();
        assert.equal(await receiptRaw(killed.operation), raw);
      }
      interruptions.push({ ...killed, receipt: durable, outcome: phase === 'prepared' ? 'explicitly-cancelled-without-delivery' : 'delivery-confirmed-and-replay-refused', lockScope: 'verifier parent retains device lock; killed child runs actual shareFiles with real adb' });
      await driver.stopApp(device, helper);
    }
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
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'passed', device, tokens, receipts, product, interruptions, fixturesRemoved: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), tokens, prepared, receipts, product, interruptions, lease: await inspectDeviceLock(device) }, null, 2)); throw error;
}
