import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectAdbServerEvidence } from './adb-server-evidence.mjs';

export async function observeAdbTransport(device, directory, adb = 'adb') {
  const events = [], snapshots = [];
  let dropped = 0, error, finished, stopped = false;
  const tracker = spawn(adb, ['track-devices', '-l'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => tracker.once('close', (code, signal) => { finished = { code, signal }; resolve(finished); }));
  tracker.on('error', value => { error = String(value); });
  const record = (stream, data) => {
    if (events.length === 512) { events.shift(); dropped++; }
    events.push({ at: new Date().toISOString(), stream, text: data.toString('utf8').slice(0, 8192) });
  };
  tracker.stdout.on('data', data => record('stdout', data));
  tracker.stderr.on('data', data => record('stderr', data));
  const save = () => writeFile(join(directory, 'adb-transport.json'), JSON.stringify({ version: 1, scope: 'read-only-transport-observation', device, pid: tracker.pid, error, finished, dropped, events, snapshots }, null, 2));
  const snapshot = async (phase, includeLogs = false) => {
    const commands = [
      ['devices', ['devices', '-l']],
      ['bootId', ['-s', device, 'shell', 'cat', '/proc/sys/kernel/random/boot_id']],
      ['adbdPid', ['-s', device, 'shell', 'pidof', 'adbd']],
      ...(includeLogs ? [['adbdLog', ['-s', device, 'logcat', '-d', '-b', 'all', '-t', '200', '-s', 'adbd:D', '*:S']]] : []),
    ];
    const results = await Promise.all(commands.map(async ([name, args]) => {
      try {
        const result = await promisify(execFile)(adb, args, { windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 });
        return { name, status: 'passed', stdout: result.stdout, stderr: result.stderr };
      } catch (error) { return { name, status: 'failed', error: String(error), stdout: error.stdout, stderr: error.stderr }; }
    }));
    const server = includeLogs ? await collectAdbServerEvidence(join(directory, `adb-server-${snapshots.length}`), adb) : undefined;
    const result = { phase, at: new Date().toISOString(), results, server };
    snapshots.push(result); await save(); return result;
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!finished) tracker.kill();
    const timer = setTimeout(() => { if (!finished) tracker.kill('SIGKILL'); }, 5000);
    try { await exited; } finally { clearTimeout(timer); await save(); }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ADB device tracker did not produce an initial snapshot')), 10000);
      tracker.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      tracker.once('error', error => { clearTimeout(timer); reject(error); });
      tracker.once('close', () => { clearTimeout(timer); reject(new Error('ADB device tracker exited during startup')); });
    });
    await snapshot('before');
    return { snapshot, stop };
  } catch (error) { await stop(); throw error; }
}
