import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export type MonitorStatus = 'queued' | 'running' | 'releasing' | 'completed' | 'released' | 'failed' | 'interrupted';
export interface MonitorRecord {
  readonly version: 1;
  readonly id: string;
  readonly deviceId: string;
  readonly intervalMs: number;
  readonly durationMs: number;
  readonly rootDirectory: string;
  readonly owner: { readonly pid: number; readonly host: string; readonly session: string };
  readonly startedAt: string;
  status: MonitorStatus;
  sampleCount: number;
  lastCapturedAt?: string;
  finishedAt?: string;
  error?: string;
}
export const terminalMonitor = (status: MonitorStatus) => ['completed', 'released', 'failed', 'interrupted'].includes(status);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class MonitorStore {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(readonly directory: string, private readonly session: string = randomUUID()) { if (!uuidPattern.test(session)) throw new Error('Invalid monitor worker session'); }
  private path(id: string) {
    if (!/^monitor-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid monitor id');
    return join(this.directory, id);
  }
  async create(deviceId: string, intervalMs: number, durationMs: number): Promise<MonitorRecord> {
    if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 60000) throw new Error('Monitor interval must be 500..60000 ms');
    if (!Number.isInteger(durationMs) || durationMs < intervalMs || durationMs > 3600000) throw new Error('Monitor duration must be at least one interval and at most 3600000 ms');
    const id = `monitor-${randomUUID()}`;
    const path = this.path(id);
    await mkdir(path, { recursive: true });
    const rootDirectory = await realpath(path);
    const record: MonitorRecord = { version: 1, id, deviceId, intervalMs, durationMs, rootDirectory, owner: { pid: process.pid, host: hostname(), session: this.session }, startedAt: new Date().toISOString(), status: 'queued', sampleCount: 0 };
    await this.save(record);
    return record;
  }
  async save(record: MonitorRecord): Promise<void> {
    if (record.owner.session !== this.session || record.owner.pid !== process.pid) throw new Error('Monitor is owned by another worker');
    const snapshot = JSON.stringify(record, null, 2);
    const previous = this.writes.get(record.id) ?? Promise.resolve();
    const current = previous.then(async () => {
      const root = this.path(record.id);
      try {
        const existing = JSON.parse(await readFile(join(root, 'monitor.json'), 'utf8')) as MonitorRecord;
        if (existing.owner.session !== this.session) throw new Error('Monitor owner changed');
        if (terminalMonitor(existing.status)) {
          if (JSON.stringify(existing, null, 2) !== snapshot) throw new Error('Terminal monitor cannot be rewritten');
          return;
        }
      } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
      const temporary = join(root, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, snapshot, { flag: 'wx' });
      await rename(temporary, join(root, 'monitor.json'));
    });
    this.writes.set(record.id, current);
    try { await current; } finally { if (this.writes.get(record.id) === current) this.writes.delete(record.id); }
  }
  async transferQueued(record: MonitorRecord, workerPid: number, workerSession: string): Promise<MonitorRecord> {
    if (record.owner.session !== this.session || record.owner.pid !== process.pid) throw new Error('Monitor is owned by another worker');
    if (record.status !== 'queued' || !Number.isInteger(workerPid) || workerPid < 1 || !uuidPattern.test(workerSession)) throw new Error('Invalid queued monitor transfer');
    const path = join(this.path(record.id), 'monitor.json'), existing = JSON.parse(await readFile(path, 'utf8')) as MonitorRecord;
    if (existing.status !== 'queued' || existing.owner.session !== this.session || existing.owner.pid !== process.pid) throw new Error('Queued monitor changed before transfer');
    const transferred: MonitorRecord = { ...record, owner: { pid: workerPid, host: hostname(), session: workerSession } };
    const temporary = join(this.path(record.id), `transfer-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(transferred, null, 2), { flag: 'wx' }); await rename(temporary, path);
    return transferred;
  }
  async failTransferredStartup(id: string, workerPid: number, workerSession: string, error: string): Promise<MonitorRecord> {
    if (!Number.isInteger(workerPid) || workerPid < 1 || !uuidPattern.test(workerSession) || !error) throw new Error('Invalid failed monitor transfer');
    const path = join(this.path(id), 'monitor.json'), existing = JSON.parse(await readFile(path, 'utf8')) as MonitorRecord;
    if (existing.status !== 'queued' || existing.owner.pid !== workerPid || existing.owner.session !== workerSession) throw new Error('Transferred monitor changed before startup failure');
    const failed: MonitorRecord = { ...existing, status: 'failed', finishedAt: new Date().toISOString(), error };
    const temporary = join(this.path(id), `startup-failure-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(failed, null, 2), { flag: 'wx' }); await rename(temporary, path);
    return failed;
  }
  async get(id: string): Promise<MonitorRecord> {
    const monitorRoot = this.path(id);
    let rootStat;
    try { rootStat = await lstat(monitorRoot); } catch (error) { throw error; }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid persisted monitor');
    const value = JSON.parse(await readFile(join(monitorRoot, 'monitor.json'), 'utf8')) as MonitorRecord;
    let rootMatches = false;
    if (typeof value.rootDirectory === 'string') {
      try { rootMatches = await realpath(value.rootDirectory) === await realpath(monitorRoot); } catch { /* invalid or replaced monitor root */ }
    }
    if (value.version !== 1 || value.id !== id || typeof value.deviceId !== 'string' || !value.deviceId || !Number.isInteger(value.intervalMs) || value.intervalMs < 500 || value.intervalMs > 60000 || !Number.isInteger(value.durationMs) || value.durationMs < value.intervalMs || value.durationMs > 3600000 || !Number.isInteger(value.sampleCount) || value.sampleCount < 0 || !value.owner || !Number.isInteger(value.owner.pid) || value.owner.pid < 1 || typeof value.owner.host !== 'string' || !value.owner.host || typeof value.owner.session !== 'string' || !value.owner.session || !rootMatches || !['queued', 'running', 'releasing', 'completed', 'released', 'failed', 'interrupted'].includes(value.status)) throw new Error('Invalid persisted monitor');
    if (!terminalMonitor(value.status) && value.owner.host === hostname()) {
      try { process.kill(value.owner.pid, 0); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return { ...value, status: 'interrupted', error: 'Monitor owner process is no longer alive; retained samples remain available' }; }
    }
    if (!terminalMonitor(value.status) && await this.releaseRequested(id)) return { ...value, status: 'releasing' };
    return value;
  }
  async list(): Promise<MonitorRecord[]> {
    await mkdir(this.directory, { recursive: true });
    return Promise.all((await readdir(this.directory)).filter(name => /^monitor-[a-f0-9-]{36}$/.test(name)).map(name => this.get(name)));
  }
  async requestRelease(id: string): Promise<MonitorRecord> {
    const monitor = await this.get(id);
    if (terminalMonitor(monitor.status)) return monitor;
    await writeFile(join(this.path(id), 'release.request'), JSON.stringify({ requestedAt: new Date().toISOString() }));
    return { ...monitor, status: 'releasing' };
  }
  async releaseRequested(id: string): Promise<boolean> {
    try { await readFile(join(this.path(id), 'release.request')); return true; }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false; throw error; }
  }
}
