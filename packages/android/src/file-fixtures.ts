import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import type { FileFixture } from '@appvanta/core';
import { fixturePathPattern } from '@appvanta/core';

const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
interface FileEntry { path: string; temporary: string; existed: boolean; backup: string; originalSha256?: string; preparedSha256: string; restored: boolean; error?: string }
function fileSession(device: string, root: string, entries: FileEntry[], recovering = false) {
  const directory = join(root, 'fixtures');
  const exec = async (...args: string[]) => (await promisify(execFile)('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true })).stdout.trim();
  const shell = (command: string) => exec('shell', command);
  const save = async () => {
    const temporary = join(directory, `files-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 2, device, entries }, null, 2), { flag: 'wx' });
    await rename(temporary, join(directory, 'summary.json'));
  };
  const safe = async (path: string) => {
    const parent = posix.dirname(path);
    await shell(`test -d ${quote(parent)}`);
    if (await shell(`readlink -f ${quote(parent)}`) !== parent) throw new Error('Fixture parent is missing or contains symlinks');
    if (await shell(`if [ -L ${quote(path)} ] || [ -d ${quote(path)} ]; then echo invalid; fi`)) throw new Error('Fixture destination is a symlink or directory');
  };
  const digest = async (path: string) => {
    const hash = (await shell(`sha256sum ${quote(path)}`)).split(/\s+/)[0]!;
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Cannot hash fixture');
    return hash;
  };
  const stop = async () => {
    const errors = [];
    for (const entry of [...entries].reverse()) {
      if (entry.restored && !recovering) continue;
      try {
        await safe(entry.path);
        await safe(entry.temporary);
        if (recovering) {
          const exists = await shell(`if [ -e ${quote(entry.path)} ]; then echo yes; fi`);
          const current = exists ? await digest(entry.path) : undefined;
          const original = entry.existed ? entry.originalSha256 : undefined;
          if (current !== original && (entry.restored || current !== entry.preparedSha256)) throw new Error('Fixture content changed outside preparation; refusing recovery');
        }
        if (entry.existed) {
          const backup = join(directory, entry.backup);
          if (await realpath(backup) !== join(await realpath(directory), entry.backup)) throw new Error('Fixture backup is outside evidence directory');
          if (createHash('sha256').update(await readFile(backup)).digest('hex') !== entry.originalSha256) throw new Error('Fixture backup integrity mismatch');
          await exec('push', backup, entry.temporary);
          await shell(`mv -f ${quote(entry.temporary)} ${quote(entry.path)}`);
          if (await digest(entry.path) !== entry.originalSha256) throw new Error('Fixture restoration hash mismatch');
        } else await shell(`rm -f ${quote(entry.path)}`);
        await shell(`rm -f ${quote(entry.temporary)}`);
        entry.restored = true;
        delete entry.error;
      } catch (error) { entry.error = String(error); errors.push(error); }
      await save();
    }
    if (errors.length) throw new AggregateError(errors, 'Fixture restoration failed; backups retained');
  };
  return { save, safe, shell, exec, digest, stop, directory };
}

/** Only use under the corresponding device recovery lease. */
export async function recoverFileFixtures(device: string, root: string) {
  const value = JSON.parse(await readFile(join(root, 'fixtures/summary.json'), 'utf8'));
  if (value?.version !== 2 || value.device !== device || !Array.isArray(value.entries) || value.entries.length > 20) throw new Error('Invalid or unbound file recovery record');
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== 'string' || !new RegExp(fixturePathPattern).test(entry.path) || typeof entry.temporary !== 'string' || posix.dirname(entry.temporary) !== posix.dirname(entry.path) || !/^\.appvanta-[a-f0-9-]{36}$/.test(posix.basename(entry.temporary)) || typeof entry.backup !== 'string' || !/^\d+\.original\.bin$/.test(entry.backup) || typeof entry.existed !== 'boolean' || typeof entry.restored !== 'boolean' || !/^[a-f0-9]{64}$/.test(entry.preparedSha256) || (entry.existed && !/^[a-f0-9]{64}$/.test(entry.originalSha256))) throw new Error('Invalid file recovery entry');
    if (seen.has(entry.path) || seen.has(entry.temporary)) throw new Error('Duplicate file recovery entry');
    seen.add(entry.path); seen.add(entry.temporary);
  }
  await fileSession(device, root, value.entries, true).stop();
}

export async function startFileFixtures(files: readonly FileFixture[], device: string, root: string, signal?: AbortSignal) {
  const entries: FileEntry[] = [];
  const { save, safe, shell, exec, digest, stop, directory } = fileSession(device, root, entries);
  await mkdir(directory, { recursive: true });
  try {
    for (const [index, file] of files.entries()) {
      signal?.throwIfAborted();
      await safe(file.path);
      const existed = await shell(`if [ -f ${quote(file.path)} ]; then echo yes; elif [ -e ${quote(file.path)} ]; then echo invalid; fi`);
      if (existed === 'invalid') throw new Error('Fixture destination is not a regular file');
      const backup = `${index}.original.bin`;
      let originalSha256: string | undefined;
      if (existed === 'yes') {
        await exec('pull', file.path, join(directory, backup));
        originalSha256 = createHash('sha256').update(await readFile(join(directory, backup))).digest('hex');
        if (await digest(file.path) !== originalSha256) throw new Error('Fixture changed while backing up');
      }
      const preparedSha256 = createHash('sha256').update(file.content).digest('hex');
      const temporary = `${posix.dirname(file.path)}/.appvanta-${randomUUID()}`;
      entries.push({ path: file.path, temporary, existed: existed === 'yes', backup, ...(originalSha256 ? { originalSha256 } : {}), preparedSha256, restored: false });
      await save(); // Persist recovery information before the first device write.
      const prepared = join(directory, `${index}.prepared.txt`);
      await writeFile(prepared, file.content, 'utf8');
      await exec('push', prepared, temporary);
      if (await digest(temporary) !== preparedSha256) throw new Error('Prepared fixture hash mismatch');
      await safe(file.path);
      await shell(`mv -f ${quote(temporary)} ${quote(file.path)}`);
      signal?.throwIfAborted();
    }
    return { stop };
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Fixture setup and restoration failed'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); }
    throw error;
  }
}
