import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditLog } from '@appvanta/core';
import type { AppOpFixture } from '@appvanta/core';

export function parseAppOpMode(output: string, operation: string): AppOpFixture['mode'] {
  if (!/^[A-Z][A-Z0-9_]*$/.test(operation)) throw new Error('Invalid AppOps operation');
  if (/Uid mode:/.test(output)) throw new Error('UID-level AppOps overrides require separate handling');
  if (/^No operations\./m.test(output)) return 'default';
  const matches = [...output.matchAll(new RegExp(`^${operation}: (allow|ignore|deny|default)(?:;|$)`, 'gm'))];
  if (matches.length !== 1) throw new Error('Unknown or unsupported AppOps state');
  return matches[0]![1] as AppOpFixture['mode'];
}

interface AppOpEntry { packageName: string; operation: string; requested: string; before: AppOpFixture['mode']; restored: boolean; after?: string; error?: string }
function appOpsSession(device: string, root: string, entries: AppOpEntry[]) {
  const directory = join(root, 'fixtures');
  const audit = new AuditLog(join(root, 'audit.jsonl'));
  const save = async () => {
    const temporary = join(directory, `appops-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 2, device, scope: 'package-overrides', entries }, null, 2), { flag: 'wx' });
    await rename(temporary, join(directory, 'appops.json'));
  };
  const command = async (...args: string[]) => {
    const result = await promisify(execFile)('adb', ['-s', device, 'shell', 'cmd', 'appops', ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (/Error|Exception|Unknown/i.test(result.stdout + result.stderr)) throw new Error(result.stdout + result.stderr);
    return result.stdout.trim();
  };
  const record = (action: string, target: string, outcome: 'started' | 'passed' | 'failed', metadata: Record<string, string>) => audit.append({ timestamp: new Date().toISOString(), actor: `appvanta-process:${process.pid}`, action, target, outcome, metadata });
  const stop = async () => {
    const errors = [];
    for (const entry of [...entries].reverse()) {
      const target = `${device}/${entry.packageName}/${entry.operation}`;
      try {
        await record('restore-appop', target, 'started', { mode: entry.before });
        const current = parseAppOpMode(await command('get', entry.packageName, entry.operation), entry.operation);
        if (current !== entry.before && (entry.restored || current !== entry.requested)) throw new Error('AppOps changed outside fixture; refusing restoration');
        if (current !== entry.before) await command('set', entry.packageName, entry.operation, entry.before);
        entry.after = parseAppOpMode(await command('get', entry.packageName, entry.operation), entry.operation);
        if (entry.after !== entry.before) throw new Error('AppOps restoration mismatch');
        entry.restored = true;
        delete entry.error;
        await record('restore-appop', target, 'passed', { mode: entry.after });
      } catch (error) { entry.error = String(error); errors.push(error); await record('restore-appop', target, 'failed', { error: entry.error }); }
      await save();
    }
    if (errors.length) throw new AggregateError(errors, 'AppOps restoration failed');
  };
  return { save, command, record, stop };
}

/** Caller must hold exclusive recovery ownership for this device/run. */
export async function recoverAppOps(device: string, root: string) {
  const value = JSON.parse(await readFile(join(root, 'fixtures/appops.json'), 'utf8'));
  const modes = ['allow', 'ignore', 'deny', 'default'];
  if (value?.version !== 2 || value.device !== device || value.scope !== 'package-overrides' || !Array.isArray(value.entries) || value.entries.length > 20) throw new Error('Invalid or unbound AppOps recovery record');
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.packageName !== 'string' || !/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(entry.packageName) || typeof entry.operation !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(entry.operation) || !modes.includes(entry.before) || !modes.includes(entry.requested) || typeof entry.restored !== 'boolean') throw new Error('Invalid AppOps recovery entry');
    const key = `${entry.packageName}/${entry.operation}`;
    if (seen.has(key)) throw new Error('Duplicate AppOps recovery entry');
    seen.add(key);
  }
  await appOpsSession(device, root, value.entries).stop();
}

export async function startAppOps(fixtures: readonly AppOpFixture[], device: string, root: string, signal?: AbortSignal) {
  await mkdir(join(root, 'fixtures'), { recursive: true });
  const entries: AppOpEntry[] = [];
  const { save, command, record, stop } = appOpsSession(device, root, entries);
  try {
    for (const fixture of fixtures) {
      signal?.throwIfAborted();
      const before = parseAppOpMode(await command('get', fixture.packageName, fixture.operation), fixture.operation);
      entries.push({ ...fixture, requested: fixture.mode, before, restored: false });
      await save();
      const target = `${device}/${fixture.packageName}/${fixture.operation}`;
      await record('prepare-appop', target, 'started', { before, requested: fixture.mode });
      try {
        await command('set', fixture.packageName, fixture.operation, fixture.mode);
        const prepared = parseAppOpMode(await command('get', fixture.packageName, fixture.operation), fixture.operation);
        if (prepared !== fixture.mode) throw new Error('AppOps preparation mismatch');
        await record('prepare-appop', target, 'passed', { before, prepared });
      } catch (error) { await record('prepare-appop', target, 'failed', { error: String(error) }); throw error; }
      signal?.throwIfAborted();
    }
    return { stop };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'AppOps setup and restoration failed'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); }
    throw error;
  }
}
