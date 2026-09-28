import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withDeviceLock } from '@appvanta/core';
import { listAndroidAvds } from './emulators.js';

export async function startAndroidAvd(name: string, port = 5554, timeoutMs = 120000, gpu?: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Invalid AVD name');
  if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2) throw new Error('AVD port must be even and between 5554 and 5682');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Invalid AVD boot timeout');
  if (gpu !== undefined && !['auto', 'host', 'software', 'lavapipe', 'swiftshader', 'swangle'].includes(gpu)) throw new Error('Invalid emulator GPU mode');
  const inventory = await listAndroidAvds();
  if (!inventory.avds.some(avd => avd.name === name)) throw new Error(`AVD is not configured: ${name}`);
  const adb = process.env.ADB_PATH || 'adb';
  const run = async (args: string[]) => (await promisify(execFile)(adb, args, { windowsHide: true, encoding: 'utf8', timeout: 5000 })).stdout.trim();
  return withDeviceLock(`avd:${name}`, async () => {
    const devices = (await run(['devices'])).split(/\r?\n/).map(line => /^(emulator-\d+)\s+(\S+)/.exec(line)).filter(item => item !== null);
    let serial = `emulator-${port}`, reused = false;
    for (const device of devices) {
      if (device[2] !== 'device') throw new Error(`Cannot identify ${device[1]} while ${device[2]}; resolve it before starting another emulator`);
      const avd = (await run(['-s', device[1]!, 'emu', 'avd', 'name'])).split(/\r?\n/).map(value => value.trim()).filter(Boolean)[0];
      if (avd === name) { serial = device[1]!; reused = true; break; }
    }
    if (!reused && devices.some(device => device[1] === serial)) throw new Error(`Requested emulator port is occupied: ${serial}`);
    if (reused && gpu !== undefined) throw new Error('GPU mode applies only to a new emulator process; stop the existing AVD before requesting a mode');
    return withDeviceLock(serial, async () => {
      const root = resolve('.appvanta/emulators', `${Date.now()}-${randomUUID()}`);
      await mkdir(root, { recursive: true });
      const startedAt = new Date().toISOString();
      let child: ReturnType<typeof spawn> | undefined, spawnError: Error | undefined;
      const args = ['-avd', name, '-port', String(port), '-no-window', '-no-audio', '-no-snapshot-save', ...(gpu ? ['-gpu', gpu] : [])];
      const save = async (status: string, detail?: string) => {
        const result = { version: 1, status, name, serial, reused, startedAt, updatedAt: new Date().toISOString(),
          ...(child?.pid ? { pid: child.pid } : {}), executable: inventory.executable, ...(reused ? {} : { args }), directory: root, ...(detail ? { detail } : {}) };
        await writeFile(join(root, 'startup.json'), JSON.stringify(result, null, 2)); return result;
      };
      await save('starting');
      if (!reused) {
        const log = await open(join(root, 'emulator.log'), 'wx');
        try {
          child = spawn(inventory.executable, args, { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
          child.on('error', error => { spawnError = error; }); child.unref();
        } finally { await log.close(); }
        await save('booting');
      }
      const deadline = Date.now() + timeoutMs;
      let lastError = '';
      while (Date.now() < deadline) {
        if (spawnError || child && (child.exitCode !== null || child.signalCode !== null)) {
          const result = await save('failed', String(spawnError ?? `Emulator exited: ${child?.exitCode}`));
          throw new Error(`AVD startup failed; inspect ${result.directory}`);
        }
        try {
          const actualName = (await run(['-s', serial, 'emu', 'avd', 'name'])).split(/\r?\n/).map(value => value.trim()).filter(Boolean)[0];
          if (actualName !== name) throw new Error(`AVD identity mismatch at ${serial}`);
          if (await run(['-s', serial, 'shell', 'getprop', 'sys.boot_completed']) === '1') return save('ready');
        } catch (error) { lastError = String(error); }
        await delay(Math.min(500, Math.max(0, deadline - Date.now())));
      }
      return save('boot-timeout', lastError || 'Boot completion was not observed; process was left running');
    });
  });
}
