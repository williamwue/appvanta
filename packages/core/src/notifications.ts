import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface TaskCompletionEvent {
  readonly version: 1;
  readonly type: 'task.completed';
  readonly taskId: string;
  readonly status: 'passed' | 'failed' | 'cancelled';
  readonly finishedAt: string;
  readonly runDirectory?: string;
}
export interface CompletionNotificationRecord {
  readonly event: TaskCompletionEvent;
  readonly webhookUrl?: string;
  readonly eventId: string;
  readonly delivery: 'local' | 'pending' | 'delivered' | 'failed';
  readonly signed?: boolean;
  readonly attemptCount: number;
  readonly attempts: readonly { readonly attempt: number; readonly attemptedAt: string; readonly responseStatus?: number; readonly error?: string }[];
  readonly responseStatus?: number;
  readonly error?: string;
  readonly path: string;
}

export interface CompletionNotificationOptions {
  readonly webhookUrl?: string;
  readonly allowedOrigins?: readonly string[];
  readonly signingSecret?: string;
  readonly maxAttempts?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly timeoutMs?: number;
  readonly send?: (url: string, body: string, signal: AbortSignal, headers: Readonly<Record<string, string>>) => Promise<{ ok: boolean; status: number }>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function validateWebhookUrl(value: string, allowedOrigins: readonly string[]): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Webhook must be an HTTP(S) URL without credentials, query or fragment');
  const allowed = new Set(allowedOrigins.map(origin => new URL(origin).origin));
  if (!allowed.has(url.origin)) throw new Error(`Webhook origin is not allowed: ${url.origin}`);
  return url.toString();
}

export function validateWebhookSigningSecret(value: string): string {
  if (Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 4096 || value.includes('\0')) throw new Error('Webhook signing secret must be 32 to 4096 UTF-8 bytes without NUL');
  return value;
}

function retryableStatus(status: number): boolean { return status === 408 || status === 425 || status === 429 || status >= 500; }

export async function emitTaskCompletion(directory: string, event: TaskCompletionEvent, options: CompletionNotificationOptions = {}): Promise<CompletionNotificationRecord> {
  const notifications = join(directory, 'notifications'); await mkdir(notifications, { recursive: true });
  const path = join(notifications, 'completion.json'), body = JSON.stringify(event), eventId = createHash('sha256').update(body).digest('hex');
  const write = async (record: CompletionNotificationRecord) => {
    const temporary = join(notifications, `completion-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx' });
    await rename(temporary, path);
  };
  if (!options.webhookUrl) {
    const record: CompletionNotificationRecord = { event, eventId, delivery: 'local', attemptCount: 0, attempts: [], path };
    await write(record); return record;
  }
  let url: string;
  try { url = validateWebhookUrl(options.webhookUrl, options.allowedOrigins ?? []); }
  catch (error) {
    const record: CompletionNotificationRecord = { event, eventId, webhookUrl: options.webhookUrl, delivery: 'failed', attemptCount: 0, attempts: [], error: error instanceof Error ? error.message : String(error), path };
    await write(record); return record;
  }
  const maxAttempts = options.maxAttempts ?? 3, timeoutMs = options.timeoutMs ?? 10000, retryDelaysMs = options.retryDelaysMs ?? [250, 1000];
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('Webhook maxAttempts must be 1 to 5');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Webhook timeoutMs must be 100 to 60000');
  if (retryDelaysMs.length < maxAttempts - 1 || retryDelaysMs.some(value => !Number.isInteger(value) || value < 0 || value > 60000)) throw new Error('Webhook retry delays must cover every retry and be 0 to 60000 milliseconds');
  if (options.signingSecret !== undefined) validateWebhookSigningSecret(options.signingSecret);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'AppVanta/0.1', 'x-appvanta-event': event.type, 'x-appvanta-event-id': eventId, 'x-appvanta-timestamp': timestamp };
  if (options.signingSecret) headers['x-appvanta-signature'] = `sha256=${createHmac('sha256', options.signingSecret).update(`${timestamp}.${body}`).digest('hex')}`;
  const attempts: { attempt: number; attemptedAt: string; responseStatus?: number; error?: string }[] = [];
  let record: CompletionNotificationRecord = { event, eventId, webhookUrl: url, delivery: 'pending', signed: Boolean(options.signingSecret), attemptCount: 0, attempts, path };
  await write(record);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let shouldRetry = false;
    try {
      const response = options.send ? await options.send(url, body, AbortSignal.timeout(timeoutMs), headers) : await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      attempts.push({ attempt, attemptedAt: new Date().toISOString(), responseStatus: response.status });
      if (response.ok) record = { event, eventId, webhookUrl: url, delivery: 'delivered', signed: Boolean(options.signingSecret), attemptCount: attempts.length, attempts, responseStatus: response.status, path };
      else {
        shouldRetry = retryableStatus(response.status) && attempt < maxAttempts;
        record = { event, eventId, webhookUrl: url, delivery: shouldRetry ? 'pending' : 'failed', signed: Boolean(options.signingSecret), attemptCount: attempts.length, attempts, responseStatus: response.status, error: `Webhook returned HTTP ${response.status}`, path };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); attempts.push({ attempt, attemptedAt: new Date().toISOString(), error: message }); shouldRetry = attempt < maxAttempts;
      record = { event, eventId, webhookUrl: url, delivery: shouldRetry ? 'pending' : 'failed', signed: Boolean(options.signingSecret), attemptCount: attempts.length, attempts, error: message, path };
    }
    await write(record);
    if (record.delivery === 'delivered' || !shouldRetry) break;
    await (options.sleep ? options.sleep(retryDelaysMs[attempt - 1]!) : delay(retryDelaysMs[attempt - 1]!));
  }
  return record;
}
