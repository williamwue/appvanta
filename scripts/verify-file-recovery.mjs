import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectDeviceLock, recoverDeviceLock } from '../packages/core/dist/device-lock.js';
import { recoverFileFixtures } from '../packages/android/dist/file-fixtures.js';
const device = process.argv[2]; assert(device, 'Specify device');
const id = Date.now(), root = resolve('.appvanta/runs', `file-recovery-${id}`);
await mkdir(root, { recursive: true });
const target = `/storage/emulated/0/Download/appvanta-recovery-${id}.txt`, created = target + '.new';
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000 }).trim();
const original = Buffer.from([0, 255, 65, 13, 10]);
const seed = join(root, 'seed.bin'); await writeFile(seed, original); adb('push', seed, target);
const content = '恢复测试 😀\n';
const core = pathToFileURL(resolve('packages/core/dist/device-lock.js')).href;
const fixture = pathToFileURL(resolve('packages/android/dist/file-fixtures.js')).href;
const code = `import {withDeviceLock, bindDeviceLockRun} from ${JSON.stringify(core)}; import {startFileFixtures} from ${JSON.stringify(fixture)}; await withDeviceLock(${JSON.stringify(device)}, async () => { await bindDeviceLockRun(${JSON.stringify(device)}, ${JSON.stringify(root)}); await startFileFixtures(${JSON.stringify([{ path: target, content }, { path: created, content }])}, ${JSON.stringify(device)}, ${JSON.stringify(root)}); console.log('ready'); await new Promise(() => setInterval(() => {}, 1000)); });`;
const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
const exited = once(child, 'exit');
try {
  await once(child.stdout, 'data', { signal: AbortSignal.timeout(30000) });
  child.kill('SIGKILL'); await exited;
  const lease = await inspectDeviceLock(device); assert.equal(lease.owner, 'dead');
  await recoverDeviceLock(device, lease.lease.token, async originalLease => {
    assert.deepEqual(JSON.parse(await readFile(join(root, 'device-lease.json'), 'utf8')), originalLease);
    const external = join(root, 'external.txt'); await writeFile(external, 'external change'); adb('push', external, target);
    await assert.rejects(recoverFileFixtures(device, root), /restoration failed/);
    assert.equal(adb('shell', 'cat', target), 'external change');
    // Only undo our deliberate fault, then retry the retained recovery record.
    const prepared = join(root, 'fixtures/0.prepared.txt'); adb('push', prepared, target);
    await recoverFileFixtures(device, root);
    await recoverFileFixtures(device, root);
    const pulled = join(root, 'restored.bin'); adb('pull', target, pulled);
    assert.deepEqual(await readFile(pulled), original);
    assert.equal(adb('shell', `test ! -e '${created}' && echo absent`), 'absent');
  });
  assert.equal(await inspectDeviceLock(device), null);
  await assert.rejects(recoverFileFixtures('different-device', root), /unbound/);
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, target, created, evidence: JSON.parse(await readFile(join(root, 'fixtures/summary.json'), 'utf8')) }, null, 2));
  adb('shell', 'rm', '-f', target);
  console.log(JSON.stringify({ status: 'passed', root }));
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
