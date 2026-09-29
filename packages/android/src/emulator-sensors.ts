import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type Vector = [number, number, number];
export interface EmulatorShakeOptions { readonly axis: 'x' | 'y' | 'z'; readonly amplitude: number; readonly cycles: number; readonly intervalMs: number }
const exec = promisify(execFile);
function vector(value: unknown): Vector {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== 'number' || !Number.isFinite(item) || Math.abs(item) > 200)) throw new Error('Invalid acceleration vector');
  return [...value] as Vector;
}
export function parseEmulatorAcceleration(output: string): Vector {
  const match = /^acceleration = ([^:\r\n]+):([^:\r\n]+):([^:\r\n]+)[\r\n]+OK[\r\n]*$/.exec(output.trimStart());
  if (!match || match.slice(1).some(part => !part.trim())) throw new Error('Unverified emulator acceleration response');
  return vector(match.slice(1).map(Number));
}
export function accelerationSequence(original: Vector, options: EmulatorShakeOptions): Vector[] {
  vector(original);
  if (!['x', 'y', 'z'].includes(options.axis) || !Number.isFinite(options.amplitude) || options.amplitude < 1 || options.amplitude > 30
    || !Number.isSafeInteger(options.cycles) || options.cycles < 1 || options.cycles > 20
    || !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 50 || options.intervalMs > 1000) throw new Error('Invalid emulator shake options');
  const axis = ['x', 'y', 'z'].indexOf(options.axis);
  return Array.from({ length: options.cycles * 2 }, (_, index) => {
    const value = [...original] as Vector;
    value[axis] = value[axis]! + options.amplitude * (index % 2 ? -1 : 1);
    return vector(value);
  });
}
const same = (a: Vector, b: Vector) => a.every((value, index) => Math.abs(value - b[index]!) <= 0.0001);
async function consoleCommand(adb: string, device: string, args: string[], signal?: AbortSignal) {
  if (!/^emulator-\d+$/.test(device)) throw new Error('Sensor injection requires an Android Emulator serial');
  signal?.throwIfAborted();
  const result = await exec(adb, ['-s', device, 'emu', 'sensor', ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true, ...(signal ? { signal } : {}) });
  return result.stdout;
}
export async function readEmulatorAcceleration(adb: string, device: string, signal?: AbortSignal): Promise<Vector> {
  return parseEmulatorAcceleration(await consoleCommand(adb, device, ['get', 'acceleration'], signal));
}
async function setAcceleration(adb: string, device: string, value: Vector, signal?: AbortSignal) {
  const output = await consoleCommand(adb, device, ['set', 'acceleration', value.join(':')], signal);
  if (output.trim() !== 'OK') throw new Error('Emulator rejected acceleration update');
}
export async function restoreEmulatorShake(adb: string, device: string, recordPath: string): Promise<void> {
  const bytes = await readFile(recordPath), record = JSON.parse(bytes.toString('utf8'));
  if (record.version !== 1 || record.device !== device || !Array.isArray(record.sequence) || record.sequence.length < 2 || record.sequence.length > 40) throw new Error('Invalid emulator shake recovery record');
  const original = vector(record.original), sequence = record.sequence.map(vector);
  if (!record.options || JSON.stringify(sequence) !== JSON.stringify(accelerationSequence(original, record.options))) throw new Error('Emulator shake recovery plan mismatch');
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  let receiptBytes: string | undefined;
  try { receiptBytes = await readFile(`${recordPath}.restored.json`, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (receiptBytes !== undefined) {
    const receipt = JSON.parse(receiptBytes);
    if (receipt.version !== 1 || receipt.device !== device || receipt.sourceSha256 !== sourceSha256
      || !same(vector(receipt.restored), original) || typeof receipt.restoredAt !== 'string'
      || !Number.isFinite(Date.parse(receipt.restoredAt))) throw new Error('Invalid emulator shake restoration receipt');
    return;
  }
  const current = await readEmulatorAcceleration(adb, device);
  if (![original, ...sequence].some(value => same(current, value))) throw new Error('Acceleration changed externally; recovery record retained');
  if (!same(current, original)) await setAcceleration(adb, device, original);
  const restored = await readEmulatorAcceleration(adb, device);
  if (!same(restored, original)) throw new Error('Acceleration restoration unverified');
  const handle = await open(`${recordPath}.restored.json`, 'wx');
  try {
    await handle.writeFile(JSON.stringify({ version: 1, device, sourceSha256, restored, restoredAt: new Date().toISOString() }, null, 2));
    await handle.sync();
  } finally { await handle.close(); }
}

/** Caller must hold the device lease for the entire operation and recovery. */
export async function shakeEmulator(adb: string, device: string, directory: string, options: EmulatorShakeOptions, signal?: AbortSignal) {
  const original = await readEmulatorAcceleration(adb, device, signal);
  const sequence = accelerationSequence(original, options);
  await mkdir(directory, { recursive: true });
  const recordPath = join(directory, `shake-${Date.now()}-${randomUUID()}.json`);
  const handle = await open(recordPath, 'wx');
  try { await handle.writeFile(JSON.stringify({ version: 1, device, original, sequence, options }, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try {
    for (const value of sequence) {
      signal?.throwIfAborted();
      await setAcceleration(adb, device, value, signal);
      const observed = await readEmulatorAcceleration(adb, device, signal);
      if (!same(observed, value)) throw new Error('Acceleration update unverified');
      await delay(options.intervalMs, undefined, signal ? { signal } : {});
    }
  } finally {
    try { await restoreEmulatorShake(adb, device, recordPath); }
    catch (error) { throw Object.assign(new Error(`Emulator sensor restoration failed; record retained: ${recordPath}`, { cause: error }), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); }
  }
  return { recordPath, original, samples: sequence.length, restored: true as const };
}
