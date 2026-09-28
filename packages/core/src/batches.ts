import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseFlow, type FlowDefinition } from './flow-schema.js';

export type BatchStatus = 'queued' | 'running' | 'cancelling' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
export interface BatchRecord {
  readonly version: 1;
  readonly id: string;
  readonly deviceIds: readonly string[];
  readonly flow: FlowDefinition;
  readonly concurrency: number;
  readonly owner: { readonly pid: number; readonly host: string; readonly session: string };
  readonly startedAt: string;
  status: BatchStatus;
  finishedAt?: string;
  runDirectory?: string;
  result?: unknown;
  error?: string;
}
export const terminalBatch = (status: BatchStatus) => ['passed', 'failed', 'cancelled', 'interrupted'].includes(status);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class BatchStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly directory: string, private readonly session: string = randomUUID()) { if (!uuidPattern.test(session)) throw new Error('Invalid batch worker session'); }
  private path(id: string) {
    if (!/^batch-task-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid batch id');
    return join(this.directory, id);
  }
  async create(deviceIds: readonly string[], flow: FlowDefinition, concurrency: number): Promise<BatchRecord> {
    if (!deviceIds.length || deviceIds.length > 100 || deviceIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(deviceIds).size !== deviceIds.length) throw new Error('Batch requires 1 to 100 unique devices');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Batch concurrency must be 1 to 32');
    const record: BatchRecord = { version: 1, id: `batch-task-${randomUUID()}`, deviceIds: [...deviceIds], flow: parseFlow(flow), concurrency, owner: { pid: process.pid, host: hostname(), session: this.session }, startedAt: new Date().toISOString(), status: 'queued' };
    await mkdir(this.directory, { recursive: true }); await mkdir(this.path(record.id)); await this.save(record); return record;
  }
  async save(record: BatchRecord): Promise<void> {
    if (record.owner.session !== this.session || record.owner.pid !== process.pid) throw new Error('Batch is owned by another worker');
    const snapshot = JSON.stringify(record, null, 2), previous = this.writes.get(record.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      const root = this.path(record.id);
      try {
        const existing = JSON.parse(await readFile(join(root, 'batch.json'), 'utf8')) as BatchRecord;
        if (existing.owner.session !== this.session) throw new Error('Batch owner changed');
        if (terminalBatch(existing.status)) { if (JSON.stringify(existing, null, 2) !== snapshot) throw new Error('Terminal batch cannot be rewritten'); return; }
      } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
      const temporary = join(root, `state-${randomUUID()}.tmp`); await writeFile(temporary, snapshot, { flag: 'wx' }); await rename(temporary, join(root, 'batch.json'));
    });
    this.writes.set(record.id, current); try { await current; } finally { if (this.writes.get(record.id) === current) this.writes.delete(record.id); }
  }
  async transferQueued(record: BatchRecord, workerPid: number, workerSession: string): Promise<BatchRecord> {
    if (record.owner.session !== this.session || record.owner.pid !== process.pid) throw new Error('Batch is owned by another worker');
    if (record.status !== 'queued' || !Number.isInteger(workerPid) || workerPid < 1 || !uuidPattern.test(workerSession)) throw new Error('Invalid queued batch transfer');
    const path = join(this.path(record.id), 'batch.json'), existing = JSON.parse(await readFile(path, 'utf8')) as BatchRecord;
    if (existing.status !== 'queued' || existing.owner.session !== this.session || existing.owner.pid !== process.pid) throw new Error('Queued batch changed before transfer');
    const transferred: BatchRecord = { ...record, owner: { pid: workerPid, host: hostname(), session: workerSession } };
    const temporary = join(this.path(record.id), `transfer-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(transferred, null, 2), { flag: 'wx' }); await rename(temporary, path);
    return transferred;
  }
  async failTransferredStartup(id: string, workerPid: number, workerSession: string, error: string): Promise<BatchRecord> {
    if (!Number.isInteger(workerPid) || workerPid < 1 || !uuidPattern.test(workerSession) || !error) throw new Error('Invalid failed batch transfer');
    const path = join(this.path(id), 'batch.json'), existing = JSON.parse(await readFile(path, 'utf8')) as BatchRecord;
    if (existing.status !== 'queued' || existing.owner.pid !== workerPid || existing.owner.session !== workerSession) throw new Error('Transferred batch changed before startup failure');
    const failed: BatchRecord = { ...existing, status: 'failed', finishedAt: new Date().toISOString(), error };
    const temporary = join(this.path(id), `startup-failure-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(failed, null, 2), { flag: 'wx' }); await rename(temporary, path);
    return failed;
  }
  async get(id: string): Promise<BatchRecord> {
    const value = JSON.parse(await readFile(join(this.path(id), 'batch.json'), 'utf8')) as BatchRecord;
    if (value.version !== 1 || value.id !== id || !Array.isArray(value.deviceIds) || !value.deviceIds.length || value.deviceIds.length > 100 || value.deviceIds.some(device => typeof device !== 'string' || !device) || new Set(value.deviceIds).size !== value.deviceIds.length || !Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 32 || !value.owner || !Number.isInteger(value.owner.pid) || value.owner.pid < 1 || typeof value.owner.host !== 'string' || typeof value.owner.session !== 'string' || !['queued', 'running', 'cancelling', 'passed', 'failed', 'cancelled', 'interrupted'].includes(value.status)) throw new Error('Invalid persisted batch');
    const flow = parseFlow(value.flow);
    const record = { ...value, flow };
    if (!terminalBatch(record.status) && record.owner.host === hostname()) {
      try { process.kill(record.owner.pid, 0); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return { ...record, status: 'interrupted', error: 'Batch owner process is no longer alive; completed device evidence remains available' }; }
    }
    if (!terminalBatch(record.status) && await this.cancellationRequested(id)) return { ...record, status: 'cancelling' };
    return record;
  }
  async list(): Promise<BatchRecord[]> {
    await mkdir(this.directory, { recursive: true });
    return Promise.all((await readdir(this.directory)).filter(name => /^batch-task-[a-f0-9-]{36}$/.test(name)).map(name => this.get(name)));
  }
  async requestCancel(id: string): Promise<BatchRecord> {
    const batch = await this.get(id); if (terminalBatch(batch.status)) return batch;
    await writeFile(join(this.path(id), 'cancel.request'), JSON.stringify({ requestedAt: new Date().toISOString() })); return { ...batch, status: 'cancelling' };
  }
  async cancellationRequested(id: string): Promise<boolean> {
    try { await readFile(join(this.path(id), 'cancel.request')); return true; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  }
}
