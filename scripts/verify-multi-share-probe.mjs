import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { withDeviceLock, inspectDeviceLock } from '../packages/core/dist/index.js';
import { AdbDriver } from '../packages/android/dist/index.js';

const device = process.argv[2]; assert(device);
const directory = resolve('.appvanta/runs', `multi-share-probe-${Date.now()}`);
await mkdir(directory, { recursive: true });
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', device, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000 })).stdout;
const source = 'dev.appvanta.share.source', receiver = 'dev.appvanta.share.receiver', relay = 'dev.appvanta.share.relayprobe';
const driver = new AdbDriver({ artifactsDirectory: join(directory, 'observations') });
const tokens = [randomUUID(), randomUUID()];
const uris = tokens.map(token => `content://${source}/payload/${token}`);
const waitText = text => driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text }, timeoutMs: 15000 });
const prepare = async (operation, index, grant = true) => {
  await adb('shell', 'am', 'start', '-W', '-n', `${relay}/.RelayActivity`, '-d', uris[index], '--es', 'operation', operation, '--ei', 'index', String(index), ...(grant ? ['--grant-read-uri-permission'] : []));
};
const noDelivery = async () => adb('shell', 'run-as', receiver, 'test', '!', '-e', 'files/received.json');
const prepared = []; const evidence = {};
try {
  await withDeviceLock(device, async () => {
    for (const fixture of ['share-source', 'share-receiver', 'share-relay-probe']) await adb('install', '-r', resolve(`.appvanta/${fixture}/appvanta-${fixture}.apk`));
    await driver.stopApp(device, receiver); await driver.stopApp(device, relay);
    await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
    await driver.stopApp(device, source);
    for (const [index, token] of tokens.entries()) {
      await adb('shell', 'am', 'start', '-W', '-n', `${source}/.SourceActivity`, '--es', 'token', token, '--ei', 'seed', String(index));
      prepared.push(token);
      await waitText(`Ready ${token}`);
    }
    await prepare(randomUUID(), 0, false);
    await waitText('Read grant required'); await noDelivery(); evidence.withoutGrantRejected = true;
    await driver.stopApp(device, relay);
    const interrupted = randomUUID();
    await prepare(interrupted, 0); await waitText(`Prepared ${interrupted}`);
    await driver.stopApp(device, relay);
    await prepare(interrupted, 1); await waitText('Missing or mismatched preparation'); await noDelivery(); evidence.lostPreparationRejected = true;
    await driver.stopApp(device, relay);
    const operation = randomUUID();
    await prepare(operation, 0); await waitText(`Prepared ${operation}`); await noDelivery();
    await prepare(operation, 1); await waitText('received');
    const report = JSON.parse(await adb('exec-out', 'run-as', receiver, 'cat', 'files/received.json'));
    await writeFile(join(directory, 'received.json'), JSON.stringify(report, null, 2));
    assert.equal(report.status, 'received'); assert.equal(report.clipCount, 2); assert.equal(report.items.length, 2);
    for (const [index, item] of report.items.entries()) {
      assert.equal(item.uri, uris[index]); assert.equal(item.bytes, 4096); assert.equal(item.readPermission, 0);
      assert.equal(item.writeDenied, true); assert.equal(item.flags & 1, 1); assert.equal(item.flags & 2, 0);
      assert.equal(item.mimeType, 'application/octet-stream');
      assert.equal(item.sha256, createHash('sha256').update(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + index) & 255))).digest('hex'));
    }
    evidence.report = report;
    await driver.stopApp(device, relay); await driver.stopApp(device, receiver);
    for (const token of prepared) {
      await driver.stopApp(device, source);
      await adb('shell', 'am', 'start', '-W', '-n', `${source}/.SourceActivity`, '--es', 'token', token, '--ez', 'cleanup', 'true');
      await waitText(`Removed ${token}`);
      await adb('shell', 'run-as', source, 'test', '!', '-e', `files/${token}.bin`);
    }
    evidence.fixturesRemoved = true;
    await driver.stopApp(device, source);
    await adb('shell', 'run-as', receiver, 'rm', '-f', 'files/received.json');
  });
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'passed', device, tokens, ...evidence, scope: 'native relay probe only; no product multi-attachment action' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), tokens, prepared, ...evidence, lease: await inspectDeviceLock(device) }, null, 2));
  throw error;
}
