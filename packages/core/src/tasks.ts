import { mkdir, readFile, writeFile, rename, readdir, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { parseFlow, type FlowDefinition } from './flow-schema.js';
import type { CompletionNotificationRecord } from './notifications.js';

export type TaskStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskRecord {
  readonly version: 1;
  readonly id: string;
  readonly deviceId: string;
  readonly flow: FlowDefinition;
  readonly owner: { readonly pid: number; readonly host: string; readonly session: string };
  readonly startedAt: string;
  revision?: number;
  status: TaskStatus;
  finishedAt?: string;
  runDirectory?: string;
  result?: unknown;
  error?: string;
  completionWebhook?: string;
  notification?: CompletionNotificationRecord;
}
export interface ReservedTaskReceipt {
  readonly id: string;
  readonly digestSha256: string;
}
export const terminalTask = (status: TaskStatus) => ['passed', 'failed', 'cancelled', 'interrupted'].includes(status);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isCode = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
const createFlowDigest = (flow: FlowDefinition) => createHash('sha256').update(JSON.stringify(flow)).digest('hex');
const taskRevision = (task: TaskRecord) => {
  const revision = task.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid task revision');
  return revision;
};
const nextTaskRevision = (revision: number) => {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Task revision overflow');
  return revision + 1;
};
const renameWithRetry = async (from: string, to: string) => {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (attempt >= 39 || !isCode(error, 'EPERM') && !isCode(error, 'EACCES') && !isCode(error, 'EBUSY')) throw error;
      await delay(50);
    }
  }
};
const removeTemporary = async (path: string) => {
  try { await unlink(path); }
  catch (error) { if (!isCode(error, 'ENOENT')) { /* preserve the publication error */ } }
};
function sameReservedTask(task: TaskRecord, id: string, deviceId: string, flow: FlowDefinition,
  options: { completionWebhook?: string }) {
  return task.version === 1 && task.id === id && task.deviceId === deviceId && task.status === 'queued' &&
    isDeepStrictEqual(task.flow, flow) && (options.completionWebhook === undefined
      ? task.completionWebhook === undefined : task.completionWebhook === options.completionWebhook) &&
    !!task.owner && Number.isSafeInteger(task.owner.pid) && task.owner.pid > 0 &&
    typeof task.owner.host === 'string' && task.owner.host.trim().length > 0 && uuidPattern.test(task.owner.session);
}

/** A single owner writes each task; other processes can query or request cancellation. */
export class TaskStore {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly lastWrittenRevision = new WeakMap<object, number>();
  constructor(readonly directory: string, private readonly session: string = randomUUID()) { if (!uuidPattern.test(session)) throw new Error('Invalid task worker session'); }
  get workerSession(): string { return this.session; }
  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(() => undefined, () => undefined);
    this.writes.set(id, settled);
    return current.finally(() => { if (this.writes.get(id) === settled) this.writes.delete(id); });
  }
  private path(id: string) {
    if (!/^task-[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task id');
    return join(this.directory, id);
  }
  async create(deviceId: string, flow: FlowDefinition, options: { completionWebhook?: string } = {}): Promise<TaskRecord> {
    const task: TaskRecord = { version: 1, id: `task-${randomUUID()}`, deviceId, flow, owner: { pid: process.pid, host: hostname(), session: this.session }, startedAt: new Date().toISOString(), revision: 0, status: 'queued', ...(options.completionWebhook ? { completionWebhook: options.completionWebhook } : {}) };
    await mkdir(this.directory, { recursive: true });
    await mkdir(this.path(task.id));
    await this.save(task);
    return task;
  }

  /** Publishes a task at a predetermined ID guarded by an immutable reservation marker. */
  async createReserved(id: string, deviceId: string, flow: FlowDefinition, reservation: {
    readonly id: string; readonly digestSha256: string;
  }, options: { completionWebhook?: string } = {}): Promise<TaskRecord> {
    if (!/^task-[a-f0-9-]{36}$/.test(id) || !uuidPattern.test(reservation.id) ||
      !/^[a-f0-9]{64}$/.test(reservation.digestSha256) || typeof deviceId !== 'string' || !deviceId.trim())
      throw new Error('Invalid reserved task identity');
    const parsedFlow = parseFlow(flow);
    const expectedMarker = { version: 1, taskId: id, reservationId: reservation.id,
      reservationDigestSha256: reservation.digestSha256, deviceId,
      flowSha256: createFlowDigest(parsedFlow) };
    await mkdir(this.directory, { recursive: true });
    const root = this.path(id);
    let createdDirectory = true;
    try { await mkdir(root); }
    catch (error) { if (!isCode(error, 'EEXIST')) throw error; createdDirectory = false; }
    const markerPath = join(root, 'reservation.json');
    let marker: unknown;
    try { marker = JSON.parse(await readFile(markerPath, 'utf8')); }
    catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      // A fresh directory gets its immutable marker before task.json. A directory
      // that already existed without it is an ambiguous crash artifact.
      if (!createdDirectory) {
        for (let attempt = 0; attempt < 20; attempt++) {
          await delay(5);
          try { marker = JSON.parse(await readFile(markerPath, 'utf8')); break; }
          catch (retryError) { if (!isCode(retryError, 'ENOENT')) throw retryError; }
        }
        if (!marker) throw new Error('Reserved task directory is missing its reservation marker');
      }
      if (marker) { /* another publisher won the marker race */ }
      else {
      const names = await readdir(root);
      if (names.length) throw new Error('Reserved task directory is missing its reservation marker');
      try {
        const handle = await open(markerPath, 'wx');
        try { await handle.writeFile(JSON.stringify(expectedMarker, null, 2)); await handle.sync(); }
        finally { await handle.close(); }
        marker = expectedMarker;
      } catch (markerError) {
        if (!isCode(markerError, 'EEXIST')) throw markerError;
        marker = JSON.parse(await readFile(markerPath, 'utf8'));
      }
      }
    }
    if (!isDeepStrictEqual(marker, expectedMarker)) throw new Error('Reserved task marker does not match request');
    const taskPath = join(root, 'task.json');
    let names = await readdir(root);
    for (let attempt = 0; attempt < 20 && !names.includes('task.json') &&
      names.some(name => /^state-[a-f0-9-]+\.tmp$/.test(name)); attempt++) {
      await delay(5); names = await readdir(root);
    }
    if (names.some(name => name !== 'reservation.json' && name !== 'task.json'))
      throw new Error('Reserved task directory contains ambiguous crash artifacts');
    try {
      const existing = JSON.parse(await readFile(taskPath, 'utf8')) as TaskRecord;
      if (!sameReservedTask(existing, id, deviceId, parsedFlow, options))
        throw new Error('Reserved task identity or Flow differs from existing task');
      if (existing.owner.host !== hostname())
        throw new Error('Reserved task owner host is unknown; refusing adoption');
      // A task owned by another live process must never be silently adopted.
      if (existing.owner.pid !== process.pid || existing.owner.session !== this.session) {
        try { process.kill(existing.owner.pid, 0); throw new Error('Reserved task is owned by a live worker'); }
        catch (error) { if (error instanceof Error && error.message === 'Reserved task is owned by a live worker') throw error; if (!isCode(error, 'ESRCH')) throw error; }
      }
      // Preserve the queued record for an explicit adoptReserved/claimReserved
      // call. Calling get() here would project a dead owner to interrupted.
      return existing;
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
    const task: TaskRecord = { version: 1, id, deviceId, flow: parsedFlow,
      owner: { pid: process.pid, host: hostname(), session: this.session }, startedAt: new Date().toISOString(),
      revision: 0, status: 'queued', ...(options.completionWebhook ? { completionWebhook: options.completionWebhook } : {}) };
    try {
      // The task file itself is the cross-process publication point. wx prevents a
      // concurrent publisher from replacing a valid task or stealing its owner.
      const handle = await open(taskPath, 'wx');
      try { await handle.writeFile(JSON.stringify(task, null, 2)); await handle.sync(); }
      finally { await handle.close(); }
      return task;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      return this.createReserved(id, deviceId, parsedFlow, reservation, options);
    }
  }

  /**
   * Adopt a queued task published by an adjudicated reservation after its
   * previous worker died. The reservation marker is the immutable capability;
   * callers must provide its id and digest and the expected task revision.
   * This deliberately reads task.json directly instead of get(), because get()
   * projects a dead owner to `interrupted` and would make a safe adoption
   * indistinguishable from an unsafe continuation.
   */
  async adoptReserved(id: string, reservation: ReservedTaskReceipt, expectedRevision?: number): Promise<TaskRecord> {
    return this.claimReservedInternal(id, reservation, expectedRevision, 'queued');
  }

  /** Claim a queued reserved task for execution, atomically transferring its
   * dead local owner and changing its state to running. */
  async claimReserved(id: string, reservation: ReservedTaskReceipt, expectedRevision?: number): Promise<TaskRecord> {
    return this.claimReservedInternal(id, reservation, expectedRevision, 'running');
  }

  private async claimReservedInternal(id: string, reservation: ReservedTaskReceipt,
    expectedRevision: number | undefined, status: 'queued' | 'running'): Promise<TaskRecord> {
    if (!/^task-[a-f0-9-]{36}$/.test(id) || !reservation || !uuidPattern.test(reservation.id) ||
      !/^[a-f0-9]{64}$/.test(reservation.digestSha256)) throw new Error('Invalid reserved task claim');
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
      throw new Error('Invalid reserved task revision');
    return this.enqueue(id, async () => {
      const root = this.path(id);
      const claimLockPath = join(root, 'reserved-claim.lock');
      let claimLock: Awaited<ReturnType<typeof open>> | undefined;
      for (let attempt = 0; attempt < 5 && !claimLock; attempt++) {
        try {
          claimLock = await open(claimLockPath, 'wx');
          await claimLock.writeFile(JSON.stringify({ version: 1, pid: process.pid, host: hostname(), session: this.session,
            startedAt: new Date().toISOString(), revision: expectedRevision ?? null }));
          await claimLock.sync();
        } catch (error) {
          if (claimLock) { await claimLock.close().catch(() => {}); claimLock = undefined; }
          if (!isCode(error, 'EEXIST')) throw error;
          let lock: any;
          try { lock = JSON.parse(await readFile(claimLockPath, 'utf8')); }
          catch (readError) { if (isCode(readError, 'ENOENT')) continue; throw readError; }
          if (!lock || lock.version !== 1 || !Number.isSafeInteger(lock.pid) || lock.pid < 1 ||
            typeof lock.host !== 'string' || !uuidPattern.test(lock.session))
            throw new Error('Invalid reserved task claim lock; refusing takeover');
          if (lock.host !== hostname()) throw new Error('Reserved task claim owner is unknown; refusing takeover');
          try { process.kill(lock.pid, 0); throw new Error('Reserved task claim is already in progress'); }
          catch (ownerError) {
            if (ownerError instanceof Error && ownerError.message === 'Reserved task claim is already in progress') throw ownerError;
            if (!isCode(ownerError, 'ESRCH')) throw new Error('Reserved task claim owner is unknown; refusing takeover');
          }
          const stale = `${claimLockPath}.stale-${randomUUID()}`;
          try { await rename(claimLockPath, stale); await unlink(stale); }
          catch (renameError) { if (!isCode(renameError, 'ENOENT')) throw renameError; }
        }
      }
      if (!claimLock) throw new Error('Reserved task claim lock changed repeatedly');
      try {
      const marker = JSON.parse(await readFile(join(root, 'reservation.json'), 'utf8')) as Record<string, unknown>;
      if (marker.version !== 1 || marker.taskId !== id || marker.reservationId !== reservation.id ||
        marker.reservationDigestSha256 !== reservation.digestSha256 || marker.deviceId === undefined ||
        typeof marker.flowSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(marker.flowSha256))
        throw new Error('Reserved task marker does not match claim');
      const existing = JSON.parse(await readFile(join(root, 'task.json'), 'utf8')) as TaskRecord;
      if (existing.version !== 1 || existing.id !== id || existing.status !== 'queued' || !existing.owner ||
        !Number.isSafeInteger(existing.owner.pid) || existing.owner.pid < 1 || typeof existing.owner.session !== 'string' ||
        !uuidPattern.test(existing.owner.session) || typeof existing.owner.host !== 'string' || existing.owner.host !== hostname() ||
        marker.deviceId !== existing.deviceId || marker.flowSha256 !== createFlowDigest(existing.flow))
        throw new Error('Reserved task is not queued on this host');
      const revision = taskRevision(existing);
      if (expectedRevision !== undefined && revision !== expectedRevision)
        throw new Error('Reserved task revision changed');
      const alreadyOwned = existing.owner.pid === process.pid && existing.owner.session === this.session;
      if (!alreadyOwned) {
        try { process.kill(existing.owner.pid, 0); throw new Error('Reserved task owner is still alive'); }
        catch (error) {
          if (error instanceof Error && error.message === 'Reserved task owner is still alive') throw error;
          if (!isCode(error, 'ESRCH')) throw new Error('Reserved task owner is unknown; refusing adoption');
        }
      }
      const next: TaskRecord = { ...existing, owner: { pid: process.pid, host: hostname(), session: this.session },
        status, revision: nextTaskRevision(revision) };
      const temporary = join(root, `reserved-claim-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' });
      try { await renameWithRetry(temporary, join(root, 'task.json')); }
      catch (error) { await removeTemporary(temporary); throw error; }
      return next;
      } finally {
        await claimLock.close().catch(() => {});
        await unlink(claimLockPath).catch(() => {});
      }
    });
  }
  async save(task: TaskRecord): Promise<void> {
    if (task.owner.session !== this.session || task.owner.pid !== process.pid) throw new Error('Task is owned by another worker');
    const expectedRevision = taskRevision(task);
    let writeRevision = expectedRevision;
    await this.enqueue(task.id, async () => {
      const root = this.path(task.id);
      try {
        const existing = JSON.parse(await readFile(join(root, 'task.json'), 'utf8')) as TaskRecord;
        if (!existing.owner || existing.owner.session !== this.session || existing.owner.pid !== process.pid || existing.owner.host !== hostname()) throw new Error('Task owner changed');
        const actualRevision = taskRevision(existing);
        const sameObjectContinuation = this.lastWrittenRevision.get(task) === actualRevision;
        if (actualRevision !== expectedRevision && !sameObjectContinuation) throw new Error('Task revision changed');
        writeRevision = actualRevision;
        if (terminalTask(existing.status)) {
          if (JSON.stringify(existing, null, 2) !== JSON.stringify(task, null, 2)) throw new Error('Terminal task cannot be rewritten');
          return;
        }
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      const next = { ...task, revision: nextTaskRevision(writeRevision) };
      const snapshot = JSON.stringify(next, null, 2);
      const temporary = join(root, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, snapshot, { flag: 'wx' });
      try { await renameWithRetry(temporary, join(root, 'task.json')); }
      catch (error) { await removeTemporary(temporary); throw error; }
      (task as { revision?: number }).revision = next.revision;
      this.lastWrittenRevision.set(task, next.revision);
    });
  }
  async transferQueued(task: TaskRecord, workerPid: number, workerSession: string): Promise<TaskRecord> {
    if (task.owner.session !== this.session || task.owner.pid !== process.pid) throw new Error('Task is owned by another worker');
    if (task.status !== 'queued' || !Number.isInteger(workerPid) || workerPid < 1 || !uuidPattern.test(workerSession)) throw new Error('Invalid queued task transfer');
    const expectedRevision = task.revision ?? 0;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid task revision');
    return this.enqueue(task.id, async () => {
      const path = join(this.path(task.id), 'task.json'), existing = JSON.parse(await readFile(path, 'utf8')) as TaskRecord;
      if (existing.status !== 'queued' || !existing.owner || existing.owner.session !== this.session || existing.owner.pid !== process.pid || existing.owner.host !== hostname()) throw new Error('Queued task changed before transfer');
      const actualRevision = taskRevision(existing);
      if (actualRevision !== expectedRevision) throw new Error('Task revision changed before transfer');
      const transferred: TaskRecord = { ...existing, revision: nextTaskRevision(actualRevision), owner: { pid: workerPid, host: hostname(), session: workerSession } };
      const temporary = join(this.path(task.id), `transfer-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(transferred, null, 2), { flag: 'wx' });
      try { await renameWithRetry(temporary, path); }
      catch (error) { await removeTemporary(temporary); throw error; }
      return transferred;
    });
  }
  async failTransferredStartup(id: string, workerPid: number, workerSession: string, error: string): Promise<TaskRecord> {
    if (!Number.isInteger(workerPid) || workerPid < 1 || !uuidPattern.test(workerSession) || !error) throw new Error('Invalid failed task transfer');
    return this.enqueue(id, async () => {
      const path = join(this.path(id), 'task.json'), existing = JSON.parse(await readFile(path, 'utf8')) as TaskRecord;
      if (existing.status !== 'queued' || !existing.owner || existing.owner.pid !== workerPid || existing.owner.session !== workerSession || existing.owner.host !== hostname()) throw new Error('Transferred task changed before startup failure');
      const failed: TaskRecord = { ...existing, revision: nextTaskRevision(taskRevision(existing)), status: 'failed', finishedAt: new Date().toISOString(), error };
      const temporary = join(this.path(id), `startup-failure-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(failed, null, 2), { flag: 'wx' });
      try { await renameWithRetry(temporary, path); }
      catch (renameError) { await removeTemporary(temporary); throw renameError; }
      return failed;
    });
  }
  async get(id: string): Promise<TaskRecord> {
    const value = JSON.parse(await readFile(join(this.path(id), 'task.json'), 'utf8')) as TaskRecord;
    if (value.version !== 1 || value.id !== id || value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0) || !value.owner || !Number.isInteger(value.owner.pid) || value.owner.pid < 1 || typeof value.owner.host !== 'string' || !['queued', 'running', 'pausing', 'paused', 'cancelling', 'passed', 'failed', 'cancelled', 'interrupted'].includes(value.status)) throw new Error('Invalid persisted task');
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
