import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditLog } from '@appvanta/core';
import type { PermissionFixture } from '@appvanta/core';

interface PermissionState { granted: boolean; flags: string[] }
interface PermissionEntry extends PermissionFixture { before: PermissionState; prepared: PermissionState; restored: boolean; after?: PermissionState; error?: string }

export function parsePermissionGrant(output: string): boolean {
  const value = output.trim().toLowerCase();
  if (value === 'granted') return true;
  if (value === 'denied') return false;
  throw new Error('Unknown runtime permission grant state');
}

export function parsePermissionFlags(output: string): string[] {
  const match = /^Permission flags:\s*\[\s*([A-Z0-9_| ]*)\s*\]\s*$/m.exec(output.trim());
  if (!match) throw new Error('Unknown runtime permission flags');
  if (!match[1]?.trim()) return [];
  const flags = match[1].split('|').map(value => value.trim()).filter(Boolean);
  if (flags.some(value => !/^[A-Z][A-Z0-9_]*$/.test(value))) throw new Error('Invalid runtime permission flag');
  return [...new Set(flags.map(value => value.toLowerCase().replaceAll('_', '-')))].sort();
}

const sameState = (left: PermissionState, right: PermissionState) => left.granted === right.granted && JSON.stringify(left.flags) === JSON.stringify(right.flags);

export function parsePermissionSnapshot(output: string, packageName: string, permission: string, userId: number): PermissionState {
  const lines = output.split(/\r?\n/);
  const section = (source: string[], matches: (line: string) => boolean) => {
    const starts = source.flatMap((line, index) => matches(line) ? [index] : []);
    if (starts.length !== 1) throw new Error('Missing or ambiguous runtime permission section');
    const start = starts[0]!;
    const indent = source[start]!.search(/\S/);
    let end = start + 1;
    while (end < source.length && (!source[end]!.trim() || source[end]!.search(/\S/) > indent)) end++;
    return source.slice(start + 1, end);
  };
  const pkg = section(lines, line => line.trim().startsWith(`Package [${packageName}] (`));
  const user = section(pkg, line => line.trim().startsWith(`User ${userId}:`));
  const runtime = section(user, line => line.trim() === 'runtime permissions:');
  const entries = runtime.map(line => line.trim()).filter(line => line.startsWith(`${permission}:`));
  if (entries.length !== 1) throw new Error('Missing or ambiguous runtime permission state');
  const match = /^granted=(true|false),\s*flags=(\[[A-Z0-9_| ]*\])$/.exec(entries[0]!.slice(permission.length + 1).trim());
  if (!match) throw new Error('Unknown runtime permission snapshot');
  return { granted: match[1] === 'true', flags: parsePermissionFlags(`Permission flags: ${match[2]}`) };
}

function permissionSession(device: string, root: string, userId: number, entries: PermissionEntry[]) {
  const directory = join(root, 'fixtures');
  const audit = new AuditLog(join(root, 'audit.jsonl'));
  const adb = async (...args: string[]) => {
    const result = await promisify(execFile)('adb', ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const output = `${result.stdout}${result.stderr}`;
    if (/\b(?:Error|Exception|Unknown package|not a changeable permission type)\b/i.test(output)) throw new Error(output.trim());
    return result.stdout.trim();
  };
  const save = async () => {
    const temporary = join(directory, `permissions-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 1, device, userId, entries }, null, 2), { flag: 'wx' });
    await rename(temporary, join(directory, 'permissions.json'));
  };
  const currentUser = async () => {
    const value = Number(await adb('am', 'get-current-user'));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Cannot determine Android user');
    return value;
  };
  const state = async (entry: Pick<PermissionEntry, 'packageName' | 'permission'>): Promise<PermissionState> =>
    parsePermissionSnapshot(await adb('dumpsys', 'package', entry.packageName), entry.packageName, entry.permission, userId);
  const changeGrant = (entry: Pick<PermissionEntry, 'packageName' | 'permission'>, granted: boolean) => adb('pm', granted ? 'grant' : 'revoke', '--user', String(userId), entry.packageName, entry.permission);
  const restoreFlags = async (entry: Pick<PermissionEntry, 'packageName' | 'permission'>, desired: readonly string[]) => {
    const current = (await state(entry)).flags;
    const removed = current.filter(flag => !desired.includes(flag));
    const added = desired.filter(flag => !current.includes(flag));
    if (removed.length) await adb('pm', 'clear-permission-flags', '--user', String(userId), entry.packageName, entry.permission, ...removed);
    if (added.length) await adb('pm', 'set-permission-flags', '--user', String(userId), entry.packageName, entry.permission, ...added);
  };
  const record = (action: string, target: string, outcome: 'started' | 'passed' | 'failed', metadata: Record<string, string>) => audit.append({ timestamp: new Date().toISOString(), actor: `appvanta-process:${process.pid}`, action, target, outcome, metadata });
  const stop = async () => {
    if (await currentUser() !== userId) throw new Error('Android user changed; refusing runtime permission restoration');
    const errors: unknown[] = [];
    for (const entry of [...entries].reverse()) {
      const target = `${device}/user-${userId}/${entry.packageName}/${entry.permission}`;
      try {
        await record('restore-runtime-permission', target, 'started', { before: JSON.stringify(entry.before) });
        const current = await state(entry);
        if (!sameState(current, entry.before) && (entry.restored || !sameState(current, entry.prepared))) throw new Error('Runtime permission changed outside fixture; refusing restoration');
        if (!sameState(current, entry.before)) {
          if (current.granted !== entry.before.granted) await changeGrant(entry, entry.before.granted);
          await restoreFlags(entry, entry.before.flags);
        }
        entry.after = await state(entry);
        if (!sameState(entry.after, entry.before)) throw new Error('Runtime permission restoration mismatch');
        entry.restored = true;
        delete entry.error;
        await record('restore-runtime-permission', target, 'passed', { after: JSON.stringify(entry.after) });
      } catch (error) {
        entry.error = String(error); errors.push(error);
        await record('restore-runtime-permission', target, 'failed', { error: entry.error });
      }
      await save();
    }
    if (errors.length) throw new AggregateError(errors, 'Runtime permission restoration failed');
  };
  return { adb, currentUser, save, state, changeGrant, record, stop };
}

function validateRecord(value: unknown, device: string): { userId: number; entries: PermissionEntry[] } {
  if (!value || typeof value !== 'object') throw new Error('Invalid runtime permission recovery record');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.device !== device || !Number.isSafeInteger(record.userId) || Number(record.userId) < 0 || !Array.isArray(record.entries) || record.entries.length < 1 || record.entries.length > 20) throw new Error('Invalid or unbound runtime permission recovery record');
  const entries = record.entries as PermissionEntry[];
  const seen = new Set<string>();
  for (const entry of entries) {
    const validState = (state: unknown) => !!state && typeof state === 'object' && typeof (state as PermissionState).granted === 'boolean' && Array.isArray((state as PermissionState).flags) && (state as PermissionState).flags.every(flag => typeof flag === 'string' && /^[a-z][a-z0-9-]*$/.test(flag)) && JSON.stringify((state as PermissionState).flags) === JSON.stringify([...new Set((state as PermissionState).flags)].sort());
    if (!entry || typeof entry.packageName !== 'string' || !/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(entry.packageName) || typeof entry.permission !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(entry.permission) || (entry.state !== 'grant' && entry.state !== 'deny') || !validState(entry.before) || !validState(entry.prepared) || typeof entry.restored !== 'boolean') throw new Error('Invalid runtime permission recovery entry');
    const key = `${entry.packageName}/${entry.permission}`;
    if (seen.has(key)) throw new Error('Duplicate runtime permission recovery entry');
    seen.add(key);
  }
  return { userId: Number(record.userId), entries };
}

/** Caller must hold exclusive recovery ownership for this device/run. */
export async function recoverRuntimePermissions(device: string, root: string) {
  const { userId, entries } = validateRecord(JSON.parse(await readFile(join(root, 'fixtures/permissions.json'), 'utf8')), device);
  await permissionSession(device, root, userId, entries).stop();
}

export async function startRuntimePermissions(fixtures: readonly PermissionFixture[], device: string, root: string, signal?: AbortSignal) {
  await mkdir(join(root, 'fixtures'), { recursive: true });
  const bootstrap = permissionSession(device, root, 0, []);
  const userId = await bootstrap.currentUser();
  const entries: PermissionEntry[] = [];
  const session = permissionSession(device, root, userId, entries);
  try {
    for (const fixture of fixtures) {
      signal?.throwIfAborted();
      const before = await session.state(fixture);
      const entry: PermissionEntry = { ...fixture, before, prepared: { granted: fixture.state === 'grant', flags: before.flags }, restored: false };
      entries.push(entry);
      await session.save();
      const target = `${device}/user-${userId}/${fixture.packageName}/${fixture.permission}`;
      await session.record('prepare-runtime-permission', target, 'started', { before: JSON.stringify(before), requested: fixture.state });
      try {
        if (before.granted !== entry.prepared.granted) await session.changeGrant(entry, entry.prepared.granted);
        entry.prepared = await session.state(entry);
        await session.save();
        if (entry.prepared.granted !== (fixture.state === 'grant')) throw new Error('Runtime permission preparation mismatch');
        await session.record('prepare-runtime-permission', target, 'passed', { prepared: JSON.stringify(entry.prepared) });
      } catch (error) { await session.record('prepare-runtime-permission', target, 'failed', { error: String(error) }); throw error; }
      signal?.throwIfAborted();
    }
    return { stop: session.stop };
  } catch (error) {
    try { await session.stop(); } catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Runtime permission setup and restoration failed'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); }
    throw error;
  }
}
