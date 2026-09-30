import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, open, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function collectAdbServerEvidence(directory, adb = process.env.ADB_PATH ?? 'adb') {
  await mkdir(directory, { recursive: true });
  const evidence = { version: 1, scope: 'read-only-adb-server-log-tail', at: new Date().toISOString() };
  try {
    const result = await promisify(execFile)(adb, ['server-status'], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 });
    evidence.serverStatus = result.stdout;
    const encoded = /^log_absolute_path:\s*(".*")\s*$/m.exec(result.stdout)?.[1];
    if (!encoded) throw new Error('ADB server did not report a log path');
    const path = JSON.parse(encoded);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('ADB log is not a regular file');
    const handle = await open(path, 'r');
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - 2 * 1024 * 1024);
      const buffer = Buffer.alloc(size - start);
      let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, buffer.length - bytes, start + bytes);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
      }
      const data = buffer.subarray(0, bytes);
      await writeFile(join(directory, 'adb-server.log'), data);
      evidence.log = { source: path, observedSize: size, offset: start, bytes, truncated: start > 0,
        shortRead: bytes !== buffer.length, sha256: createHash('sha256').update(data).digest('hex') };
    } finally { await handle.close(); }
    evidence.status = 'collected';
  } catch (error) { evidence.status = 'unavailable'; evidence.error = String(error); }
  await writeFile(join(directory, 'server-evidence.json'), JSON.stringify(evidence, null, 2));
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Specify diagnostic output directory');
  console.log(JSON.stringify(await collectAdbServerEvidence(resolve(process.argv[2]))));
}
