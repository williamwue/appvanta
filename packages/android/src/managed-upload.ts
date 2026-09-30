import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { bindDeviceLockRun, inspectDeviceLock, parseAction, recoverDeviceLock, withDeviceLock } from '@appvanta/core';

const limit = 64 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const uriFor = (id: string) => { if (!uuid.test(id)) throw new Error('Invalid upload ID'); return `content://dev.appvanta.share.uploads/files/${id}`; };
const remoteFor = (id: string) => `/data/local/tmp/appvanta-upload-${id}`;
export interface ManagedUploadOptions { readonly directory: string; readonly adbPath?: string; readonly signal?: AbortSignal }
export interface ManagedUploadReceipt { readonly state: 'prepared' | 'writing' | 'ready' | 'rejected' | 'deleted'; readonly size: number; readonly sha256: string; readonly mimeType: string }
type Execute = (args: readonly string[]) => Promise<string>;
interface Request { version: 1; operation: 'upload' | 'delete'; id: string; deviceId: string; size: number; sha256: string; mimeType: string; displayName?: string; sourcePath?: string }

export function parseManagedUploadReceipt(raw: string): ManagedUploadReceipt | null {
  if (raw.trim() === 'No result found.') return null;
  const match = /^Row: 0 state=(prepared|writing|ready|rejected|deleted), _size=(0|[1-9][0-9]*), sha256=([a-f0-9]{64}), mimeType=([^\r\n]+)$/.exec(raw.trim());
  if (!match || Number(match[2]) > limit) throw new Error('Invalid managed upload response');
  parseAction({ kind: 'share-file', uri: 'content://validation/file', mimeType: match[4] });
  return { state: match[1] as ManagedUploadReceipt['state'], size: Number(match[2]), sha256: match[3]!, mimeType: match[4]! };
}
function executeFor(device: string, options: ManagedUploadOptions, cancellable = true): Execute {
  if (!device) throw new Error('Device ID required');
  return async args => {
    if (cancellable) options.signal?.throwIfAborted();
    const { stdout, stderr } = await promisify(execFile)(options.adbPath ?? 'adb', ['-s', device, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, ...(cancellable && options.signal ? { signal: options.signal } : {}) });
    return stdout + stderr;
  };
}
async function inspect(id: string, execute: Execute) {
  return parseManagedUploadReceipt(await execute(['shell', 'content', 'query', '--uri', uriFor(id), '--projection', 'state:_size:sha256:mimeType']));
}
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
async function save(directory: string, name: string, value: unknown) {
  const raw = JSON.stringify(value, null, 2);
  const handle = await open(join(directory, name), 'wx', 0o600);
  try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
  return raw;
}
async function snapshot(source: string, directory: string, signal?: AbortSignal) {
  const input = await open(source, 'r');
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > limit) throw new Error('Upload must be a regular file of at most 64 MiB');
    const output = await open(join(directory, 'payload.bin'), 'wx', 0o600);
    const digest = createHash('sha256'); let size = 0;
    try {
      const buffer = Buffer.alloc(65536);
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead; if (size > limit) throw new Error('Upload grew beyond 64 MiB');
        const bytes = buffer.subarray(0, bytesRead); digest.update(bytes); await output.writeFile(bytes);
      }
      const after = await input.stat();
      if (before.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Source changed while taking upload snapshot');
      await output.sync();
    } finally { await output.close(); }
    return { size, sha256: digest.digest('hex') };
  } finally { await input.close(); }
}
function matches(receipt: ManagedUploadReceipt | null, request: Request) {
  if (!receipt || receipt.size !== request.size || receipt.sha256 !== request.sha256 || receipt.mimeType !== request.mimeType) throw new Error('Upload metadata does not match durable request');
  return receipt;
}
async function bind(device: string, directory: string, request: Request) {
  const raw = await save(directory, 'request.json', request);
  await bindDeviceLockRun(device, directory);
  const state = await inspectDeviceLock(device);
  if (!state?.lease.token) throw new Error('Upload lease missing');
  const binding = { version: 1, requestSha256: hash(raw), token: state.lease.token, deviceId: device };
  await save(directory, 'upload-binding.json', binding);
  return binding;
}
async function removeStaging(request: Request, owner: string, execute: Execute) {
  if (request.operation !== 'upload') return;
  const path = remoteFor(request.id);
  const state = (await execute(['shell', `if [ ! -e ${path} ] && [ ! -L ${path} ]; then echo absent; elif [ -d ${path} ] && [ ! -L ${path} ]; then cat ${path}/owner; else echo invalid; fi`])).trim();
  if (state === 'absent') return;
  if (state !== owner || (await execute(['shell', 'readlink', '-f', path])).trim() !== path) throw new Error('Remote upload directory ownership mismatch; retained');
  const entries = (await execute(['shell', 'ls', '-A', path])).trim().split(/\r?\n/);
  if (entries.some(name => name !== 'owner' && name !== 'payload')) throw new Error('Unexpected files in upload staging directory; retained');
  await execute(['shell', `rm -f ${path}/payload ${path}/owner && rmdir ${path}`]);
  if ((await execute(['shell', `if [ ! -e ${path} ] && [ ! -L ${path} ]; then echo absent; fi`])).trim() !== 'absent') throw new Error('Upload staging cleanup unverified');
}
async function removeUpload(request: Request, execute: Execute) {
  const receipt = await inspect(request.id, execute);
  if (!receipt) return;
  matches(receipt, request);
  await execute(['shell', 'content', 'delete', '--uri', uriFor(request.id)]);
  if (matches(await inspect(request.id, execute), request).state !== 'deleted') throw new Error('Upload deletion unverified');
}
export async function inspectAndroidUpload(deviceId: string, id: string, options: ManagedUploadOptions) {
  return { scope: 'read-only', resumeAuthorized: false, id, uri: uriFor(id), receipt: await inspect(id, executeFor(deviceId, options)) };
}
export async function uploadAndroidAttachment(deviceId: string, sourcePath: string, mimeType: string, options: ManagedUploadOptions, displayName = basename(sourcePath)) {
  parseAction({ kind: 'share-file', uri: 'content://validation/file', mimeType });
  if (!displayName || displayName.length > 255 || /[/\\\x00-\x1f\x7f]/.test(displayName)) throw new Error('Invalid attachment display name');
  return withDeviceLock(deviceId, async () => {
    const id = randomUUID(), directory = resolve(options.directory, 'uploads', id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const request: Request = { version: 1, operation: 'upload', id, deviceId, mimeType, displayName, sourcePath: resolve(sourcePath), ...await snapshot(sourcePath, directory, options.signal) };
    const binding = await bind(deviceId, directory, request);
    const execute = executeFor(deviceId, options);
    try {
      await execute(['shell', 'content', 'insert', '--uri', 'content://dev.appvanta.share.uploads/files', '--bind', `id:s:${id}`, '--bind', quote(`mimeType:s:${mimeType}`), '--bind', quote(`displayName:s:${displayName}`), '--bind', `size:l:${request.size}`, '--bind', `sha256:s:${request.sha256}`]);
      if (matches(await inspect(id, execute), request).state !== 'prepared') throw new Error('Upload preparation unverified');
      const remote = remoteFor(id);
      await execute(['shell', `mkdir -m 700 ${remote} && printf '%s' ${binding.requestSha256} > ${remote}/owner`]);
      await execute(['push', join(directory, 'payload.bin'), `${remote}/payload`]);
      await execute(['shell', `content write --uri ${uriFor(id)} < ${remote}/payload`]);
      const deadline = Date.now() + 20000; let receipt;
      do {
        receipt = matches(await inspect(id, execute), request);
        if (receipt.state === 'ready') break;
        if (receipt.state !== 'writing') throw new Error(`Upload ended in state ${receipt.state}`);
        await delay(100, undefined, options.signal ? { signal: options.signal } : {});
      } while (Date.now() < deadline);
      if (receipt.state !== 'ready') throw new Error('Upload completion timed out');
      await save(directory, 'ready.json', receipt);
      await removeStaging(request, binding.requestSha256, execute);
      const result = { scope: 'uploaded-only', shared: false, id, uri: uriFor(id), receipt, recordDirectory: directory };
      await save(directory, 'result.json', result); return result;
    } catch (error) { await save(directory, 'failure.json', { error: String(error), id }); throw new Error(`Upload incomplete; retained lease ${binding.token}; inspect ${id} and ${directory}`, { cause: error }); }
  });
}
export async function deleteAndroidUpload(deviceId: string, id: string, options: ManagedUploadOptions) {
  uriFor(id);
  return withDeviceLock(deviceId, async () => {
    const execute = executeFor(deviceId, options);
    const receipt = await inspect(id, execute);
    if (!receipt) return { scope: 'upload-cleanup', id, absent: true };
    const directory = resolve(options.directory, 'uploads', `delete-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const request: Request = { version: 1, operation: 'delete', id, deviceId, size: receipt.size, sha256: receipt.sha256, mimeType: receipt.mimeType };
    const binding = await bind(deviceId, directory, request);
    try {
      await removeUpload(request, execute);
      const result = { scope: 'upload-cleanup', id, deleted: true, recordDirectory: directory };
      await save(directory, 'result.json', result); return result;
    } catch (error) { await save(directory, 'failure.json', { error: String(error), id }); throw new Error(`Upload deletion incomplete; retained lease ${binding.token}; inspect ${directory}`, { cause: error }); }
  });
}
export async function recoverAndroidUpload(deviceId: string, token: string, options: ManagedUploadOptions) {
  return recoverDeviceLock(deviceId, token, async lease => {
    if (!lease.runDirectory) throw new Error('Upload lease has no bound directory');
    const directory = await realpath(lease.runDirectory);
    const raw = await readFile(join(directory, 'request.json'), 'utf8');
    if (raw.length > 16384) throw new Error('Upload request too large');
    const request = JSON.parse(raw) as Request;
    const binding = JSON.parse(await readFile(join(directory, 'upload-binding.json'), 'utf8'));
    const copy = JSON.parse(await readFile(join(directory, 'device-lease.json'), 'utf8'));
    if (!request || request.version !== 1 || !['upload', 'delete'].includes(request.operation) || request.deviceId !== deviceId || !uuid.test(request.id) || !Number.isSafeInteger(request.size) || request.size < 0 || request.size > limit || !/^[a-f0-9]{64}$/.test(request.sha256) || binding.version !== 1 || binding.requestSha256 !== hash(raw) || binding.deviceId !== deviceId || binding.token !== token || copy.token !== token || copy.deviceId !== deviceId || copy.runDirectory !== directory) throw new Error('Upload recovery binding mismatch');
    parseAction({ kind: 'share-file', uri: uriFor(request.id), mimeType: request.mimeType });
    const execute = executeFor(deviceId, options, false);
    await removeUpload(request, execute);
    await removeStaging(request, binding.requestSha256, execute);
    const result = { scope: 'upload-cleanup', resumed: false, shared: false, id: request.id, recordDirectory: directory };
    await save(directory, `recovery-${randomUUID()}.json`, result); return result;
  });
}
