import { parseAction, type Action } from '@appvanta/core';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

type Share = Extract<Action, { kind: 'share-files' }>;
type Execute = (args: readonly string[]) => Promise<string>;
const helper = 'dev.appvanta.share.helper';
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export interface AttachmentShareReceipt {
  readonly version: 1;
  readonly operation: string;
  readonly state: 'prepared' | 'dispatching' | 'dispatched' | 'cancelled' | 'rejected';
  readonly count: number;
  readonly mimeType: string;
  readonly packageName?: string;
  readonly uris: readonly string[];
  readonly error?: string;
}

export function parseAttachmentShareReceipt(raw: string, operation: string): AttachmentShareReceipt {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation)) throw new Error('Invalid attachment operation ID');
  if (raw.length > 131072) throw new Error('Attachment receipt exceeds limit');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['version', 'operation', 'state', 'count', 'mimeType', 'packageName', 'uris', 'error'].includes(key)) ||
      value.version !== 1 || value.operation !== operation || !['prepared', 'dispatching', 'dispatched', 'cancelled', 'rejected'].includes(value.state) ||
      !Number.isInteger(value.count) || value.count < 2 || value.count > 16 || !Array.isArray(value.uris) || value.uris.length > value.count || new Set(value.uris).size !== value.uris.length ||
      (['dispatching', 'dispatched'].includes(value.state) && value.uris.length !== value.count) ||
      (value.error !== undefined && (value.state !== 'rejected' || typeof value.error !== 'string' || value.error.length > 16384))) throw new Error('Invalid attachment receipt');
  for (const uri of value.uris.length ? value.uris : ['content://validation/item']) parseAction({ kind: 'share-file', uri, mimeType: value.mimeType, ...(value.packageName !== undefined ? { packageName: value.packageName } : {}) });
  return value as AttachmentShareReceipt;
}

export async function readAttachmentShare(operation: string, execute: Execute) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operation)) throw new Error('Invalid attachment operation ID');
  const raw = await execute(['exec-out', 'content', 'read', '--uri', `content://${helper}/operations/${operation}`]);
  return { scope: 'read-only' as const, resumeAuthorized: false as const, receipt: parseAttachmentShareReceipt(raw, operation), receiptSha256: createHash('sha256').update(raw).digest('hex') };
}

export function validateShareReceipt(raw: string, operation: string, action: Share, count: number, state: string): unknown {
  if (!Number.isInteger(count) || count < 0 || count > action.uris.length) throw new Error('Invalid attachment receipt count');
  if (raw.length > 131072) throw new Error('Attachment receipt exceeds limit');
  const receipt = JSON.parse(raw);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).some(key => !['version', 'operation', 'state', 'count', 'mimeType', 'packageName', 'uris'].includes(key)) ||
      receipt.version !== 1 || receipt.operation !== operation || receipt.state !== state || receipt.count !== action.uris.length ||
      receipt.mimeType !== action.mimeType || receipt.packageName !== action.packageName || !Array.isArray(receipt.uris) ||
      receipt.uris.length !== count || receipt.uris.some((uri: unknown, index: number) => uri !== action.uris[index])) throw new Error('Attachment receipt does not match requested operation');
  return receipt;
}

export async function shareFiles(input: Share, directory: string, execute: Execute, cleanup: Execute): Promise<void> {
  const action = parseAction(input);
  if (action.kind !== 'share-files') throw new Error('Expected share-files action');
  if (!(await execute(['shell', 'pm', 'path', helper])).trim().startsWith('package:')) throw new Error('Install the AppVanta share helper before sharing multiple attachments');
  const operation = randomUUID();
  await mkdir(directory, { recursive: true });
  const save = async (name: string, value: unknown) => {
    const file = await open(join(directory, `share-${operation}-${name}.json`), 'wx');
    try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
  };
  const command = (mode: string) => ['shell', 'am', 'start', '-W', '-n', `${helper}/.ShareActivity`, '--es', 'operation', operation, '--es', 'mode', mode];
  const read = ['exec-out', 'content', 'read', '--uri', `content://${helper}/operations/${operation}`];
  await save('request', { version: 1, operation, action });
  let dispatchAttempted = false, prepared = 0;
  try {
    for (const [index, uri] of action.uris.entries()) {
      await execute([...command('prepare'), ...(index === 0 ? ['-f', '0x18000000'] : []), '--ei', 'index', String(index), '--ei', 'count', String(action.uris.length), '--es', 'mimeType', quote(action.mimeType),
        ...(action.packageName ? ['--es', 'targetPackage', action.packageName] : []), '-d', quote(uri), '--grant-read-uri-permission']);
      const raw = await execute(read);
      await save(`observed-${index}`, { bytes: Buffer.byteLength(raw, 'utf8'), raw: raw.slice(0, 131072) });
      const receipt = validateShareReceipt(raw, operation, action, index + 1, 'prepared');
      prepared = index + 1;
      await save(`prepared-${prepared}`, receipt);
    }
    await save('dispatch-intent', { operation, prepared });
    dispatchAttempted = true;
    await execute(command('dispatch'));
    await save('dispatched', validateShareReceipt(await execute(read), operation, action, action.uris.length, 'dispatched'));
  } catch (error) {
    let cancellation: unknown = { attempted: false, reason: 'Dispatch outcome may be uncertain; inspect helper receipt' };
    if (!dispatchAttempted) {
      try {
        await cleanup(command('cancel'));
        const raw = await cleanup(read);
        if (raw.length > 131072) throw new Error('Attachment cancellation receipt exceeds limit');
        cancellation = { attempted: true, receipt: validateShareReceipt(raw, operation, action, JSON.parse(raw)?.uris?.length, 'cancelled') };
      } catch (cancelError) { cancellation = { attempted: true, error: String(cancelError) }; }
    }
    await save('failure', { operation, dispatchAttempted, error: String(error), cancellation });
    throw new Error(`Multi-attachment share failed; inspect operation ${operation} and ${directory}`, { cause: error });
  }
}
