import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withDeviceLock, inspectDeviceLock } from '../packages/core/dist/index.js';
import { AdbDriver, runAndroidFlow, parseUiTree } from '../packages/android/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const device = process.argv[2]; assert(device);
const directory = resolve('.appvanta/runs', `file-share-${Date.now()}`); await mkdir(directory, { recursive: true });
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', device, ...args], { windowsHide: true, timeout: 20000, encoding: 'utf8' })).stdout;
const source = 'dev.appvanta.share.source', receiver = 'dev.appvanta.share.receiver', token = randomUUID();
const uri = `content://${source}/payload/${token}`;
const action = { kind: 'share-file', uri, mimeType: 'application/octet-stream', packageName: receiver };
const flow = { name: 'Read-only attachment delivery', steps: [{ description: 'Send attachment', action }, { description: 'Receiver evidence', assertText: 'received' }] };
const driver = new AdbDriver({ artifactsDirectory: join(directory, 'observations') });
const received = async () => JSON.parse(await adb('exec-out', 'run-as', receiver, 'cat', 'files/received.json'));
const clearReceiver = async () => { await driver.stopApp(device, receiver); await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json'); };
const sha256 = createHash('sha256').update(Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 255))).digest('hex');
const results = []; let prepared = false;
try {
  await withDeviceLock(device, async () => {
    for (const fixture of ['share-source', 'share-receiver']) await adb('install', '-r', resolve(`.appvanta/${fixture}/appvanta-${fixture}.apk`));
    await driver.stopApp(device, source);
    await adb('shell', 'am', 'start', '-W', '-n', `${source}/.SourceActivity`, '--es', 'token', token);
    await driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text: `Ready ${token}` }, timeoutMs: 15000 }); prepared = true;
    await clearReceiver();
    await adb('shell', 'am', 'start', '-W', '-n', `${receiver}/.ReceiveActivity`, '-a', 'android.intent.action.SEND', '-t', action.mimeType, '--eu', 'android.intent.extra.STREAM', uri);
    await driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text: 'failed' }, timeoutMs: 15000 });
    const denied = await received(); assert.equal(denied.status, 'failed'); assert.equal(denied.readPermission, -1);
    await writeFile(join(directory, 'without-grant.json'), JSON.stringify(denied, null, 2));
  });
  const path = join(directory, 'flow.json'); await writeFile(path, JSON.stringify(flow, null, 2));
  for (const transport of ['cli', 'mcp', 'resolver-cancel', 'resolver']) {
    await withDeviceLock(device, clearReceiver);
    let result;
    if (transport === 'cli') result = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'run-flow', device, path], { windowsHide: true, timeout: 90000, encoding: 'utf8' })).stdout);
    else if (transport === 'resolver' || transport === 'resolver-cancel') {
      const { packageName, ...unaddressed } = action;
      const choice = { kind: 'text', value: 'AppVanta Share Receiver', match: 'exact' };
      const once = { kind: 'text', value: 'Just once', match: 'exact' };
      result = await runAndroidFlow(device, { name: 'System attachment receiver selection', steps: [
        { description: 'Open system resolver', action: unaddressed },
        { description: 'Verify test receiver choice', assertText: choice.value },
        ...(transport === 'resolver-cancel' ? [
          { description: 'Dismiss without selecting', action: { kind: 'back' } },
          { description: 'Source visible after dismiss', assertText: 'AppVanta Share Source' },
        ] : [
          { description: 'Select only test receiver', when: { kind: 'target-visible', target: choice }, action: { kind: 'tap', target: choice } },
          { description: 'Use only this time', when: { kind: 'target-visible', target: once }, action: { kind: 'tap', target: once } },
          { description: 'Receiver evidence', assertText: 'received' },
        ]),
      ] });
      assert.equal(result.status, 'passed');
      const xmlPath = result.steps[1].evidence.find(path => path.endsWith('.xml'));
      const nodes = parseUiTree(await readFile(join(result.runDirectory, xmlPath), 'utf8')).nodes;
      const chosen = nodes.find(node => node.text === choice.value || node.text === `Share with ${choice.value}`);
      assert(chosen && ['android', 'com.android.intentresolver'].includes(chosen.packageName), 'Choice must be in the Android system resolver');
    } else {
      const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
      try {
        const ready = readMcpResponses(child.stdout, [1]);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'attachment-verifier', version: '1' } } }) + '\n'); await ready;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const pending = readMcpResponses(child.stdout, [2], 90000);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_flow', arguments: { deviceId: device, flow } } }) + '\n');
        const response = (await pending).find(item => item.id === 2);
        assert(response?.result && !response.result.isError, JSON.stringify({ response, stderr }));
        result = JSON.parse(response.result.content[0].text);
      } finally { child.kill(); await exited; }
    }
    assert.equal(result.status, 'passed');
    if (transport === 'resolver-cancel') {
      await adb('shell', 'run-as', receiver, 'test', '!', '-e', 'files/received.json');
      results.push({ transport, result, delivered: false });
      continue;
    }
    const report = await received(); assert.equal(report.uri, uri); assert.equal(report.status, 'received');
    assert.equal(report.mimeType, action.mimeType); assert.equal(report.sha256, sha256); assert.equal(report.bytes, 4096); assert.equal(report.writeDenied, true);
    assert.equal(report.readPermission, 0);
    assert.equal(report.flags & 1, 1); assert.equal(report.flags & 2, 0);
    results.push({ transport, result, report });
  }
  const missing = await runAndroidFlow(device, { name: 'Missing attachment receiver', steps: [{ description: 'Missing destination', action: { ...action, packageName: `dev.appvanta.absent${token.replaceAll('-', '')}` } }, { description: 'Must not run', echo: 'unexpected' }] });
  assert.equal(missing.status, 'failed'); assert(!missing.steps.some(step => step.description === 'Must not run'));
  await withDeviceLock(device, async () => {
    await clearReceiver(); await driver.stopApp(device, source);
    await adb('shell', 'am', 'start', '-W', '-n', `${source}/.SourceActivity`, '--es', 'token', token, '--ez', 'cleanup', 'true');
    await driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text: `Removed ${token}` }, timeoutMs: 15000 });
    await adb('shell', 'run-as', source, 'test', '!', '-e', `files/${token}.bin`);
    await adb('shell', 'am', 'start', '-W', '-n', `${receiver}/.ReceiveActivity`, '-a', 'android.intent.action.SEND', '-t', action.mimeType, '--eu', 'android.intent.extra.STREAM', uri);
    await driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text: 'failed' }, timeoutMs: 15000 });
    const revoked = await received(); assert.equal(revoked.readPermission, -1); assert.equal(revoked.status, 'failed');
    await writeFile(join(directory, 'after-revocation.json'), JSON.stringify(revoked, null, 2));
    await clearReceiver();
    await driver.stopApp(device, source); prepared = false;
  });
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'passed', device, uri, sha256, results, missing, fixtureRemoved: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), uri, token, prepared, results, lease: await inspectDeviceLock(device) }, null, 2));
  throw error;
}
