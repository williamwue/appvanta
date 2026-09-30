import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Preserve recovery state: probes only read the device and write separate evidence.
export async function probeCaptureTransfer({ adb = 'adb', device, remote, directory, relayEnvironment }) {
  if (!/^\/(?:sdcard\/screen-[a-f0-9-]{36}\.mp4|data\/misc\/perfetto-traces\/trace-[a-f0-9-]{36}\.perfetto-trace)$/.test(remote)) throw new Error('Invalid capture probe path');
  await mkdir(directory, { recursive: true });
  const direct = { ...process.env };
  delete direct.ADB_SERVER_SOCKET;
  const execute = async (args, env) => {
    const started = Date.now();
    try {
      const result = await promisify(execFile)(adb, ['-s', device, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
      return { status: 'passed', elapsedMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { status: 'failed', elapsedMs: Date.now() - started, code: error.code, signal: error.signal, error: String(error), stdout: error.stdout, stderr: error.stderr };
    }
  };
  const metadata = await execute(['shell', `ls -l ${remote}; stat ${remote}; sha256sum ${remote}`], direct);
  const attempts = [];
  for (const [name, env, flags] of [
    ['direct', direct, []],
    ...(relayEnvironment ? [['relay', relayEnvironment, []], ['relay-uncompressed', relayEnvironment, ['-Z']]] : []),
  ]) {
    const destination = join(directory, `${name}.bin`);
    const result = await execute(['pull', ...flags, remote, destination], env);
    let artifact;
    try { const bytes = await readFile(destination); artifact = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    attempts.push({ name, ...result, artifact });
  }
  const result = { scope: 'diagnostic-only', recoveryAuthorized: false, remote, metadata, attempts };
  await writeFile(join(directory, 'transfer-probe.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}
