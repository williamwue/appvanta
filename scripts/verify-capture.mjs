import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AdbDriver } from '../packages/android/dist/index.js';

const serial = process.argv[2];
assert(serial, 'Usage: node scripts/verify-capture.mjs <device>');
const root = resolve('.appvanta/runs', `capture-${Date.now()}`);
await mkdir(root, { recursive: true });
const driver = new AdbDriver({ artifactsDirectory: root });
const exec = promisify(execFile);
const records = [];
try {
  // Both captures must outlive the old hard-coded 20-second command timeout.
  for (const [kind, remoteRoot, capture] of [
    ['screen', '/sdcard', () => driver.recordScreen(serial, 22)],
    ['perfetto', '/data/misc/perfetto-traces', () => driver.collectPerfetto(serial, 22)],
  ]) {
    const started = Date.now();
    const result = await capture();
    const elapsedMs = Date.now() - started;
    const bytes = await readFile(result.path);
    assert(elapsedMs >= 20000, 'Capture terminated prematurely');
    assert(bytes.length > 1024, 'Capture is empty or truncated');
    if (kind === 'screen') {
      assert(bytes.includes(Buffer.from('ftyp')), 'Missing MP4 file type');
      assert(bytes.includes(Buffer.from('moov')), 'Missing finalized MP4 metadata');
    }
    const remote = `${remoteRoot}/${basename(result.path)}`;
    const { stdout } = await exec('adb', ['-s', serial, 'shell', `[ ! -e '${remote}' ] && echo cleaned`], { timeout: 20000 });
    assert.equal(stdout.trim(), 'cleaned', 'Remote capture file was not removed');
    records.push({ kind, durationSeconds: 22, elapsedMs, file: basename(result.path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), remoteCleaned: true });
  }
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device: serial, records }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, records }));
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', device: serial, error: String(error), records }, null, 2));
  throw error;
}
