import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFlow, type FlowStep } from './flow-schema.js';
import { TaskStore, terminalTask } from './tasks.js';

export type TaskInstructionStatus = 'queued' | 'claimed' | 'applied' | 'failed';
export interface TaskInstructionRecord {
  readonly version: 1;
  readonly id: string;
  readonly taskId: string;
  readonly createdAt: string;
  readonly step: FlowStep;
  status: TaskInstructionStatus;
  claimedAt?: string;
  finishedAt?: string;
  error?: string;
}

export class TaskInstructionStore {
  constructor(readonly taskStore: TaskStore) {}
  private directory(taskId: string) { return join(this.taskStore.directory, taskId, 'instructions'); }
  private path(taskId: string, id: string) {
    if (!/^instruction-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid instruction id');
    return join(this.directory(taskId), `${id}.json`);
  }
  async enqueue(taskId: string, step: FlowStep): Promise<TaskInstructionRecord> {
    const task = await this.taskStore.get(taskId);
    if (terminalTask(task.status) || task.status === 'cancelling') throw new Error(`Task does not accept instructions in status ${task.status}`);
    const record: TaskInstructionRecord = { version: 1, id: `instruction-${randomUUID()}`, taskId, createdAt: new Date().toISOString(), step, status: 'queued' };
    const directory = this.directory(taskId); await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${record.id}.tmp`);
    await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx' });
    await rename(temporary, this.path(taskId, record.id));
    return record;
  }
  async list(taskId: string): Promise<TaskInstructionRecord[]> {
    await this.taskStore.get(taskId);
    const directory = this.directory(taskId); await mkdir(directory, { recursive: true });
    return this.readDirectory(taskId, directory);
  }
  /** Lists persisted instructions without creating an absent directory. */
  async listReadOnly(taskId: string): Promise<TaskInstructionRecord[]> {
    await this.taskStore.get(taskId);
    return this.readDirectory(taskId, this.directory(taskId), true);
  }
  private async readDirectory(taskId: string, directory: string, missingIsEmpty = false): Promise<TaskInstructionRecord[]> {
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if (missingIsEmpty && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(names.filter(name => /^instruction-[a-f0-9-]{36}\.json$/.test(name)).map(name => this.read(taskId, name.slice(0, -5))));
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async claimQueued(taskId: string): Promise<TaskInstructionRecord[]> {
    const claimed: TaskInstructionRecord[] = [];
    for (const record of await this.list(taskId)) if (record.status === 'queued') {
      record.status = 'claimed'; record.claimedAt = new Date().toISOString();
      await this.replace(record); claimed.push(record);
    }
    return claimed;
  }
  async finish(taskId: string, id: string, status: 'applied' | 'failed', error?: string): Promise<TaskInstructionRecord> {
    await this.taskStore.get(taskId);
    const record = await this.read(taskId, id);
    if (record.status !== 'claimed') throw new Error(`Instruction cannot finish from status ${record.status}`);
    record.status = status; record.finishedAt = new Date().toISOString();
    if (error) record.error = error;
    await this.replace(record); return record;
  }
  private async read(taskId: string, id: string): Promise<TaskInstructionRecord> {
    const value = JSON.parse(await readFile(this.path(taskId, id), 'utf8')) as TaskInstructionRecord;
    if (value.version !== 1 || value.id !== id || value.taskId !== taskId || !value.step || !['queued', 'claimed', 'applied', 'failed'].includes(value.status)) throw new Error('Invalid persisted task instruction');
    const step = parseFlow({ version: 1, name: 'Persisted instruction', steps: [value.step] }).steps[0]!;
    return { ...value, step };
  }
  private async replace(record: TaskInstructionRecord): Promise<void> {
    const path = this.path(record.taskId, record.id), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx' }); await rename(temporary, path);
  }
}
