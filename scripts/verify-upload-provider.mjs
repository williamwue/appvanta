import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeviceLock, inspectDeviceLock } from '../packages/core/dist/index.js';
import { AdbDriver } from '../packages/android/dist/index.js';

const device = process.argv[2]; assert(device);
const directory = resolve('.appvanta/runs', `upload-provider-${Date.now()}`);
await mkdir(directory, { recursive: true });
const driver = new AdbDriver({ artifactsDirectory: join(directory, 'observations') });
const adbPath = process.env.ADB_PATH ?? 'adb';
const adb = async (...args) => {
  const { stdout, stderr } = await promisify(execFile)(adbPath, ['-s', device, ...args], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  return stdout + stderr;
};
const base = 'content://dev.appvanta.share.uploads/files';
const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 255));
const sha = data => createHash('sha256').update(data).digest('hex');
const records = ['valid', 'empty', 'truncated', 'wrong-hash'].map(kind => ({ kind, id: randomUUID() }));
for (const record of records) { record.uri = `${base}/${record.id}`; record.remoteDirectory = `/data/local/tmp/appvanta-upload-${record.id}`; }
await writeFile(join(directory, 'fixtures.json'), JSON.stringify({ device, records }, null, 2));
const observations = [];
const query = uri => adb('shell', 'content', 'query', '--uri', uri);
const waitState = async (uri, state) => {
  for (let i = 0; i < 40; i++) { const value = await query(uri); if (value.includes(`state=${state}`)) return value; if (state === 'ready' && value.includes('state=rejected')) throw new Error(await adb('shell', 'content', 'query', '--uri', uri, '--projection', 'error')); await delay(100); }
  throw new Error(`Upload did not reach ${state}: ${await query(uri)}`);
};
const write = async (record, data) => {
  const local = join(directory, `${record.id}.bin`);
  await writeFile(local, data);
  await adb('shell', 'mkdir', '-m', '700', record.remoteDirectory);
  try {
    await adb('push', local, `${record.remoteDirectory}/payload`);
    return await adb('shell', `content write --uri ${record.uri} < ${record.remoteDirectory}/payload`);
  } finally {
    await adb('shell', 'rm', '-f', `${record.remoteDirectory}/payload`);
    await adb('shell', 'rmdir', record.remoteDirectory);
  }
};
try {
  await withDeviceLock(device, async () => {
    for (const fixture of ['share-helper', 'share-receiver']) await adb('install', '-r', resolve(`.appvanta/${fixture}/appvanta-${fixture}.apk`));
    for (const app of ['dev.appvanta.share.helper', 'dev.appvanta.share.receiver']) await driver.stopApp(device, app);
    for (const record of records) {
      const expected = record.kind === 'empty' ? Buffer.alloc(0) : bytes;
      const hash = record.kind === 'wrong-hash' ? '0'.repeat(64) : sha(expected);
      const create = () => adb('shell', 'content', 'insert', '--uri', base, '--bind', `id:s:${record.id}`, '--bind', 'mimeType:s:application/octet-stream', '--bind', 'displayName:s:upload.bin', '--bind', `size:l:${expected.length}`, '--bind', `sha256:s:${hash}`);
      assert.doesNotMatch(await create(), /Error|Exception/);
      assert((await query(record.uri)).includes('state=prepared'));
      assert.match(await adb('exec-out', 'content', 'read', '--uri', record.uri), /Error|Exception/);
      await write(record, record.kind === 'truncated' ? bytes.subarray(0, 1024) : expected);
      const state = ['valid', 'empty'].includes(record.kind) ? 'ready' : 'rejected';
      const receipt = await waitState(record.uri, state);
      if (state === 'ready') {
        const actual = (await promisify(execFile)(adbPath, ['-s', device, 'exec-out', 'content', 'read', '--uri', record.uri], { windowsHide: true, timeout: 20000, encoding: 'buffer' })).stdout;
        assert.deepEqual(actual, expected);
      } else assert.match(await adb('exec-out', 'content', 'read', '--uri', record.uri), /Error|Exception/);
      assert.match(await create(), /Error|Exception/);
      assert.match(await write(record, Buffer.alloc(0)), /Error|Exception/);
      assert.equal(await query(record.uri), receipt);
      observations.push({ ...record, state, receipt });
    }
    await driver.execute(device, { kind: 'share-files', uris: records.slice(0, 2).map(record => record.uri), mimeType: 'application/octet-stream', packageName: 'dev.appvanta.share.receiver' });
    await driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text: 'received' }, timeoutMs: 15000 });
    const delivered = JSON.parse(await adb('exec-out', 'run-as', 'dev.appvanta.share.receiver', 'cat', 'files/received.json'));
    await writeFile(join(directory, 'received.json'), JSON.stringify(delivered, null, 2));
    assert.equal(delivered.items.length, 2); assert.equal(delivered.clipCount, 2);
    for (const [index, item] of delivered.items.entries()) {
      assert.equal(item.uri, records[index].uri); assert.equal(item.bytes, index === 0 ? 4096 : 0);
      assert.equal(item.sha256, sha(index === 0 ? bytes : Buffer.alloc(0)));
      assert.equal(item.readPermission, 0); assert.equal(item.writeDenied, true); assert.equal(item.flags & 0xc3, 1);
    }
    for (const record of records) {
      assert.doesNotMatch(await adb('shell', 'content', 'delete', '--uri', record.uri), /Error|Exception/);
      assert((await query(record.uri)).includes('state=deleted'));
      assert.match(await adb('exec-out', 'content', 'read', '--uri', record.uri), /Error|Exception/);
      record.removed = true;
    }
    await driver.stopApp(device, 'dev.appvanta.share.receiver');
    await adb('shell', 'am', 'start', '-W', '-n', 'dev.appvanta.share.receiver/.ReceiveActivity', '-a', 'android.intent.action.SEND', '-t', 'application/octet-stream', '--eu', 'android.intent.extra.STREAM', records[0].uri);
    await driver.execute(device, { kind: 'wait', condition: { kind: 'text-visible', text: 'failed' }, timeoutMs: 15000 });
    const revoked = JSON.parse(await adb('exec-out', 'run-as', 'dev.appvanta.share.receiver', 'cat', 'files/received.json'));
    assert.equal(revoked.readPermission, -1);
    await writeFile(join(directory, 'after-delete.json'), JSON.stringify(revoked, null, 2));
    await driver.stopApp(device, 'dev.appvanta.share.receiver');
    await adb('shell', 'run-as', 'dev.appvanta.share.receiver', 'rm', '-f', 'files/received.json');
  });
  assert.equal(await inspectDeviceLock(device), null);
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'passed', device, records, observations, payloadsDeleted: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), device, records, observations, lease: await inspectDeviceLock(device) }, null, 2)); throw error;
}
