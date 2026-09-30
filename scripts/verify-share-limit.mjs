import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withDeviceLock, inspectDeviceLock } from '../packages/core/dist/index.js';
import { AdbDriver } from '../packages/android/dist/index.js';

const device = process.argv[2]; assert(device);
const directory = resolve('.appvanta/runs', `share-limit-${Date.now()}`);
await mkdir(directory, { recursive: true });
const source = 'dev.appvanta.share.source', receiver = 'dev.appvanta.share.receiver';
const tokens = Array.from({ length: 16 }, () => randomUUID());
const uris = tokens.map(token => `content://${source}/payload/${token}`);
const driver = new AdbDriver({ artifactsDirectory: join(directory, 'observations') });
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', device, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 })).stdout;
const waitText = text => driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text }, timeoutMs: 15000 });
const prepared = [], removed = [];
await writeFile(join(directory, 'fixtures.json'), JSON.stringify({ device, tokens, uris }, null, 2));
let result, report, inspection;
try {
  await withDeviceLock(device, async () => {
    for (const fixture of ['share-source', 'share-receiver', 'share-helper']) await adb('install', '-r', resolve(`.appvanta/${fixture}/appvanta-${fixture}.apk`));
    for (const app of [source, receiver, 'dev.appvanta.share.helper']) await driver.stopApp(device, app);
    await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
    for (const [index, token] of tokens.entries()) {
      await adb('shell', 'am', 'start', '-W', '-n', `${source}/.SourceActivity`, '--es', 'token', token, '--ei', 'seed', String(index));
      await waitText(`Ready ${token}`);
      prepared.push(token);
    }
  });
  const flow = { name: 'Maximum attachment delivery', steps: [
    { description: 'Send sixteen distinct attachments', action: { kind: 'share-files', uris, mimeType: 'application/octet-stream', packageName: receiver } },
    { description: 'Receiver available', assertText: 'received' },
  ] };
  const flowPath = join(directory, 'flow.json'); await writeFile(flowPath, JSON.stringify(flow));
  result = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'run-flow', device, flowPath], { encoding: 'utf8', windowsHide: true, timeout: 120000 })).stdout);
  assert.equal(result.status, 'passed');
  await withDeviceLock(device, async () => {
    report = JSON.parse(await adb('exec-out', 'run-as', receiver, 'cat', 'files/received.json'));
    await writeFile(join(directory, 'received.json'), JSON.stringify(report, null, 2));
    assert.equal(report.status, 'received'); assert.equal(report.clipCount, 16); assert.equal(report.items.length, 16);
    for (const [index, item] of report.items.entries()) {
      assert.equal(item.uri, uris[index]); assert.equal(item.mimeType, 'application/octet-stream');
      assert.equal(item.bytes, 4096); assert.equal(item.readPermission, 0); assert.equal(item.writeDenied, true);
      assert.equal(item.flags & 0xc3, 1);
      assert.equal(item.sha256, createHash('sha256').update(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + index) & 255))).digest('hex'));
    }
    assert.equal(new Set(report.items.map(item => item.sha256)).size, 16);
    const requests = (await readdir(result.runDirectory, { recursive: true })).filter(path => /share-[a-f0-9-]+-request\.json$/.test(path));
    assert.equal(requests.length, 1);
    const request = JSON.parse(await readFile(join(result.runDirectory, requests[0]), 'utf8'));
    inspection = await driver.inspectAttachmentShare(device, request.operation);
    assert.equal(inspection.receipt.state, 'dispatched'); assert.equal(inspection.receipt.count, 16);
    assert.deepEqual(inspection.receipt.uris, uris);
    await driver.stopApp(device, receiver);
    await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
    for (const token of tokens) {
      await driver.stopApp(device, source);
      await adb('shell', 'am', 'start', '-W', '-n', `${source}/.SourceActivity`, '--es', 'token', token, '--ez', 'cleanup', 'true');
      await waitText(`Removed ${token}`);
      await adb('shell', 'run-as', source, 'test', '!', '-e', `files/${token}.bin`);
      removed.push(token);
    }
    await driver.stopApp(device, source);
  });
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'passed', device, tokens, result, report, inspection, removed, fixturesRemoved: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), device, tokens, prepared, removed, result, report, inspection, lease: await inspectDeviceLock(device) }, null, 2));
  throw error;
}
