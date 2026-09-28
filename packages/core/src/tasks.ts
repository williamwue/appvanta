import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { FlowDefinition } from './flow-schema.js';
import type { CompletionNotificationRecord } from './notifications.js';

export type TaskStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskRecord {
  readonly version: 1;
  readonly id: string;
  readonly deviceId: string;
  readonly flow: FlowDefinition;
  readonly owner: { readonly pid: number; readonly host: string; readonly session: string };
  readonly startedAt: string;
  status: TaskStatus;
  finishedAt?: string;
  runDirectory?: string;
  result?: unknown;
  error?: string;
  completionWebhook?: string;
  notification?: CompletionNotificationRecord;
}
export const terminalTask = (status: TaskStatus) => ['passed', 'failed', 'cancelled', 'interrupted'].includes(status);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** A single owner writes each task; other processes can query or request cancellation. */
export class TaskStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly directory: string, private readonly session: string = randomUUID()) { if (!uuidPattern.test(session)) throw new Error('Invalid task worker session'); }
  private path(id: string) {
    if (!/^task-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task id');
    return join(this.directory, id);
  }
  async create(deviceId: string, flow: FlowDefinition, options: { completionWebhook?: string } = {}): Promise<TaskRecord> {
    const task: TaskRecord = { version: 1, id: `task-${randomUUID()}`, deviceId, flow, owner: { pid: process.pid, host: hostname(), session: this.session }, startedAt: new Date().toISOString(), status: 'queued', ...(options.completionWebhook ? { completionWebhook: options.completionWebhook } : {}) };
    await mkdir(this.directory, { recursive: true });
    await mkdir(this.path(task.id));
    await this.save(task);
    return task;
  }
  async save(task: TaskRecord): Promise<void> {
    if (task.owner.session !== this.session || task.owner.pid !== process.pid) throw new Error('Task is owned by another worker');
    const snapshot = JSON.stringify(task, null, 2);
    const previous = this.writes.get(task.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      const root = this.path(task.id);
      try {
        const existing = JSON.parse(await readFile(join(root, 'task.json'), 'utf8')) as TaskRecord;
        if (existing.owner.session !== this.session) throw new Error('Task owner changed');
        if (terminalTask(existing.status)) {
          if (JSON.stringify(existing, null, 2) !== snapshot) throw new Error('Terminal task cannot be rewritten');
          return;
        }
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      const temporary = join(root, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, snapshot, { flag: 'wx' });
      await rename(temporary, join(root, 'task.json'));
    });
    this.writes.set(task.id, current);
    try { await current; } finally { if (this.writes.get(task.id) === current) this.writes.delete(task.id); }
  }
  async transferQueued(task: TaskRecord, workerPid: number, workerSession: string): Promise<TaskRecord> {
    if (task.owner.session !== this.session || task.owner.pid !== process.pid) throw new Error('Task is owned by another worker');
    if (task.status !== 'queued' || !Number.isInteger(workerPid) || workerPid < 1 || !uuidPattern.test(workerSession)) throw new Error('Invalid queued task transfer');
    const path = join(this.path(task.id), 'task.json'), existing = JSON.parse(await readFile(path, 'utf8')) as TaskRecord;
    if (existing.status !== 'queued' || existing.owner.session !== this.session || existing.owner.pid !== process.pid) throw new Error('Queued task changed before transfer');
    const transferred: TaskRecord = { ...task, owner: { pid: workerPid, host: hostname(), session: workerSession } };
    const temporary = join(this.path(task.id), `transfer-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(transferred, null, 2), { flag: 'wx' }); await rename(temporary, path);
    return transferred;
  }
  async failTransferredStartup(id: string, workerPid: number, workerSession: string, error: string): Promise<TaskRecord> {
    if (!Number.isInteger(workerPid) || workerPid < 1 || !uuidPattern.test(workerSession) || !error) throw new Error('Invalid failed task transfer');
    const path = join(this.path(id), 'task.json'), existing = JSON.parse(await readFile(path, 'utf8')) as TaskRecord;
    if (existing.status !== 'queued' || existing.owner.pid !== workerPid || existing.owner.session !== workerSession) throw new Error('Transferred task changed before startup failure');
    const failed: TaskRecord = { ...existing, status: 'failed', finishedAt: new Date().toISOString(), error };
    const temporary = join(this.path(id), `startup-failure-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(failed, null, 2), { flag: 'wx' }); await rename(temporary, path);
    return failed;
  }
  async get(id: string): Promise<TaskRecord> {
    const value = JSON.parse(await readFile(join(this.path(id), 'task.json'), 'utf8')) as TaskRecord;
    if (value.version !== 1 || value.id !== id || !value.owner || !Number.isInteger(value.owner.pid) || value.owner.pid < 1 || typeof value.owner.host !== 'string' || !['queued', 'running', 'pausing', 'paused', 'cancelling', 'passed', 'failed', 'cancelled', 'interrupted'].includes(value.status)) throw new Error('Invalid persisted task');
    if (!terminalTask(value.status) && value.owner.host === hostname()) {
      try { process.kill(value.owner.pid, 0); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return { ...value, status: 'interrupted', error: 'Owner process is no longer alive; inspect device and network state before recovery' };
        // Access denied or an uncertain owner must not be treated as dead.
      }
    }
    if (!terminalTask(value.status) && await this.cancellationRequested(id)) return { ...value, status: 'cancelling' };
    const pauseRequested = !terminalTask(value.status) && await this.pauseRequested(id);
    if (pauseRequested && value.status !== 'paused') return { ...value, status: 'pausing' };
    if (!pauseRequested && (value.status === 'paused' || value.status === 'pausing')) return { ...value, status: 'running' };
    return value;
  }
  async list(): Promise<TaskRecord[]> {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory);
    return Promise.all(names.filter(name => /^task-[a-f0-9-]{36}$/.test(name)).map(name => this.get(name)));
  }
  async requestCancel(id: string): Promise<TaskRecord> {
    const task = await this.get(id);
    if (terminalTask(task.status)) return task;
    await writeFile(join(this.path(id), 'cancel.request'), JSON.stringify({ requestedAt: new Date().toISOString() }));
    return { ...task, status: 'cancelling' };
  }
  async cancellationRequested(id: string): Promise<boolean> {
    try { await readFile(join(this.path(id), 'cancel.request')); return true; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  }
  async requestPause(id: string): Promise<TaskRecord> {
    const task = await this.get(id);
    if (terminalTask(task.status) || task.status === 'cancelling') return task;
    const request = { version: 1, type: 'pause', requestedAt: new Date().toISOString(), token: randomUUID() };
    try { await writeFile(join(this.path(id), 'pause.request'), JSON.stringify(request), { flag: 'wx' }); }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
    await this.recordControl(id, request);
    return { ...task, status: task.status === 'paused' ? 'paused' : 'pausing' };
  }
  async requestResume(id: string): Promise<TaskRecord> {
    const task = await this.get(id);
    if (terminalTask(task.status) || task.status === 'cancelling') return task;
    try { await unlink(join(this.path(id), 'pause.request')); }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
    await this.recordControl(id, { version: 1, type: 'resume', requestedAt: new Date().toISOString(), token: randomUUID() });
    return { ...task, status: 'running' };
  }
  async pauseRequested(id: string): Promise<boolean> {
    try { await readFile(join(this.path(id), 'pause.request')); return true; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  }
  private async recordControl(id: string, record: object): Promise<void> {
    const directory = join(this.path(id), 'controls'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(record, null, 2), { flag: 'wx' });
  }
}
