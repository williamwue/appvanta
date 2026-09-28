import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface ImeState { selected: string; enabled: string[] }
const componentPattern = /^[\w.]+\/[\w.$]+$/;
const imeShell = (device: string) => async (...args: string[]) => {
  const command = args.map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(' ');
  const result = await promisify(execFile)('adb', ['-s', device, 'shell', command], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (/Exception|Error:/i.test(result.stdout)) throw new Error(result.stdout.trim());
  return result.stdout.trim();
};
const imeState = async (shell: ReturnType<typeof imeShell>): Promise<ImeState> => ({ selected: await shell('settings', 'get', 'secure', 'default_input_method'), enabled: (await shell('ime', 'list', '-s')).split(/\r?\n/).filter(Boolean).sort() });
async function saveIme(directory: string, evidence: Record<string, unknown>) {
  const temporary = join(directory, `input-method-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(evidence, null, 2), { flag: 'wx' });
  await rename(temporary, join(directory, 'input-method.json'));
}
async function restoreIme(device: string, requested: string, before: ImeState): Promise<ImeState> {
  const shell = imeShell(device);
  const current = await imeState(shell);
  const expectedEnabled = [...new Set([...before.enabled, requested])].sort();
  if (![before.selected, requested].includes(current.selected) || ![JSON.stringify(before.enabled), JSON.stringify(expectedEnabled)].includes(JSON.stringify(current.enabled))) throw new Error('Input method changed outside fixture; refusing restoration');
  if (current.selected !== before.selected) await shell('ime', 'set', before.selected);
  if (!before.enabled.includes(requested) && current.enabled.includes(requested)) await shell('ime', 'disable', requested);
  const after = await imeState(shell);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Input method state was not fully restored');
  return after;
}

/** Caller must hold exclusive recovery ownership for this device/run. */
export async function recoverImeFixture(device: string, root: string) {
  const directory = join(root, 'fixtures');
  const evidence = JSON.parse(await readFile(join(directory, 'input-method.json'), 'utf8'));
  const before = evidence?.before;
  if (evidence?.version !== 2 || evidence.device !== device || typeof evidence.requested !== 'string' || !componentPattern.test(evidence.requested) || !before || typeof before.selected !== 'string' || !componentPattern.test(before.selected) || !Array.isArray(before.enabled) || !before.enabled.every((item: unknown) => typeof item === 'string' && componentPattern.test(item)) || !before.enabled.includes(before.selected) || JSON.stringify(before.enabled) !== JSON.stringify([...new Set(before.enabled)].sort())) throw new Error('Invalid or unbound input method recovery record');
  try {
    evidence.after = await restoreIme(device, evidence.requested, before);
    evidence.restored = true;
    delete evidence.cleanupError;
    evidence.recoveredAt = new Date().toISOString();
  } catch (error) { evidence.cleanupError = String(error); evidence.restored = false; throw error; }
  finally { await saveIme(directory, evidence); }
}

export async function startImeFixture(component: string, device: string, root: string, signal?: AbortSignal) {
  const directory = join(root, 'fixtures');
  await mkdir(directory, { recursive: true });
  const shell = imeShell(device);
  const state = () => imeState(shell);
  signal?.throwIfAborted();
  const before = await state();
  if (!/^[\w.]+\/[\w.$]+$/.test(before.selected)) throw new Error('Cannot restore current input method');
  const available = (await shell('ime', 'list', '-a', '-s')).split(/\r?\n/);
  if (!available.includes(component) || !available.includes(before.selected)) throw new Error('Requested or original input method is unavailable');
  const evidence: Record<string, unknown> = { version: 2, device, requested: component, before, restored: false };
  const save = () => saveIme(directory, evidence);
  await save();
  const stop = async () => {
    try {
      evidence.after = await restoreIme(device, component, before);
      evidence.restored = true;
    } catch (error) { evidence.cleanupError = String(error); throw error; }
    finally { await save(); }
  };
  try {
    signal?.throwIfAborted();
    await shell('ime', 'enable', component);
    await shell('ime', 'set', component);
    const prepared = await state(); evidence.prepared = prepared;
    if (prepared.selected !== component || !prepared.enabled.includes(component)) throw new Error('Requested input method was not selected');
    await save();
    signal?.throwIfAborted();
    return { stop };
  } catch (error) {
    evidence.error = String(error);
    try { await stop(); } catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Input method fixture setup and cleanup failed'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); }
    throw error;
  }
}
