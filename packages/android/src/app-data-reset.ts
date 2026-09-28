import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditLog } from '@appvanta/core';

interface ResetEntry { packageName: string; status: 'pending' | 'cleared' | 'failed'; startedAt?: string; finishedAt?: string; output?: string; error?: string }
interface ResetOptions { readonly runAdb?: (args: readonly string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }> }

export async function resetApplicationData(packages: readonly string[], device: string, root: string, signal?: AbortSignal, options: ResetOptions = {}) {
  if (!packages.length || packages.length > 20 || new Set(packages).size !== packages.length || packages.some(packageName => !/^[A-Za-z0-9_.]+$/.test(packageName))) throw new Error('Invalid application data reset packages');
  const directory = join(root, 'fixtures');
  await mkdir(directory, { recursive: true });
  const entries: ResetEntry[] = packages.map(packageName => ({ packageName, status: 'pending' }));
  const audit = new AuditLog(join(root, 'audit.jsonl'));
  const runAdb = options.runAdb ?? (async (args, currentSignal) => promisify(execFile)('adb', [...args], { encoding: 'utf8', timeout: 30000, windowsHide: true, signal: currentSignal }));
  const save = async () => {
    const temporary = join(directory, `app-data-reset-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 1, device, restorable: false, entries }, null, 2), { flag: 'wx' });
    await rename(temporary, join(directory, 'app-data-reset.json'));
  };
  await save();
  for (const entry of entries) {
    signal?.throwIfAborted();
    const target = `${device}/${entry.packageName}`;
    entry.startedAt = new Date().toISOString();
    await save();
    await audit.append({ timestamp: entry.startedAt, actor: `appvanta-process:${process.pid}`, action: 'clear-application-data', target, outcome: 'started', metadata: { restorable: 'false' } });
    try {
      const installed = await runAdb(['-s', device, 'shell', 'pm', 'path', entry.packageName], signal);
      if (!installed.stdout.trim().split(/\r?\n/).some(line => line.startsWith('package:/'))) throw new Error(`Application is not installed: ${entry.packageName}`);
      const result = await runAdb(['-s', device, 'shell', 'pm', 'clear', entry.packageName], signal);
      entry.output = `${result.stdout}${result.stderr}`.trim();
      if (entry.output !== 'Success') throw new Error(`pm clear did not succeed: ${entry.output || 'empty output'}`);
      entry.status = 'cleared';
      entry.finishedAt = new Date().toISOString();
      await audit.append({ timestamp: entry.finishedAt, actor: `appvanta-process:${process.pid}`, action: 'clear-application-data', target, outcome: 'passed', metadata: { output: entry.output } });
    } catch (error) {
      entry.status = 'failed'; entry.error = String(error); entry.finishedAt = new Date().toISOString();
      await audit.append({ timestamp: entry.finishedAt, actor: `appvanta-process:${process.pid}`, action: 'clear-application-data', target, outcome: 'failed', metadata: { error: entry.error } });
      await save();
      throw error;
    }
    await save();
  }
}
