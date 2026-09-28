import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, unlink, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

const held = new AsyncLocalStorage<ReadonlyMap<string, string>>();
const active = new Map<string, string>();
const nested = new Map<string, Set<Promise<unknown>>>();
const nestedFailed = new Set<string>();
const admissionFailed = new Set<string>();
const admissions = new Map<string, { next: number; tail: Promise<void> }>();
const nestedKey = (path: string, token: string) => `${path}:${token}`;
const closing = new Map<string, string>();
const unsafe = new Map<string, string>();
const processToken = randomUUID();
const lockDirectory = () => process.env.APPVANTA_LOCK_DIRECTORY ?? join(homedir(), '.appvanta', 'device-locks');
const leasePath = (deviceId: string, directory: string) => {
  if (!deviceId.trim()) throw new Error('Device id is required');
  return join(resolve(directory), createHash('sha256').update(deviceId).digest('hex') + '.json');
};
const codeIs = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
export interface DeviceLease {
  version: 1 | 2;
  token: string;
  deviceId: string;
  pid: number;
  host: string;
  startedAt: string;
  runDirectory?: string;
  recoveredFrom?: { token: string; runDirectory?: string };
  preparationScope?: 'android-flow';
  processToken?: string;
  cleanupRequired?: { runDirectory: string; recordedAt: string; reason?: 'explicit' | 'operation-exit' | 'nested-exit' };
}

interface RecoveryGuard {
  readonly version?: 1;
  readonly pid: number;
  readonly host: string;
  readonly expectedToken: string;
  readonly recoveryToken?: string;
  readonly startedAt: string;
}

function parseRecoveryGuard(value: unknown): RecoveryGuard {
  if (!value || typeof value !== 'object') throw new Error('Invalid recovery guard; refusing takeover');
  const guard = value as Record<string, unknown>;
  if (guard.version !== undefined && guard.version !== 1 || !Number.isSafeInteger(guard.pid) || Number(guard.pid) < 1 || typeof guard.host !== 'string' ||
      typeof guard.expectedToken !== 'string' || !/^[a-f0-9-]{36}$/.test(guard.expectedToken) ||
      guard.recoveryToken !== undefined && (typeof guard.recoveryToken !== 'string' || !/^[a-f0-9-]{36}$/.test(guard.recoveryToken)) ||
      typeof guard.startedAt !== 'string' || !Number.isFinite(Date.parse(guard.startedAt))) throw new Error('Invalid recovery guard; refusing takeover');
  return guard as unknown as RecoveryGuard;
}

async function acquireRecoveryGuard(path: string, expectedToken: string, predecessorToken?: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let handle;
    try { handle = await open(path, 'wx'); }
    catch (error) {
      if (!codeIs(error, 'EEXIST')) throw error;
      const existing = parseRecoveryGuard(JSON.parse(await readFile(path, 'utf8')));
      if (existing.expectedToken !== expectedToken && existing.expectedToken !== predecessorToken) throw new Error('Recovery guard belongs to another device lease');
      if (existing.host !== hostname()) throw new Error('Recovery guard owner is unknown; refusing takeover');
      try { process.kill(existing.pid, 0); throw new Error('Recovery is already active'); }
      catch (ownerError) {
        if (ownerError instanceof Error && ownerError.message === 'Recovery is already active') throw ownerError;
        if (!codeIs(ownerError, 'ESRCH')) throw new Error('Recovery guard owner is unknown; refusing takeover');
      }
      const stale = `${path}.stale-${randomUUID()}`;
      try { await rename(path, stale); }
      catch (renameError) { if (codeIs(renameError, 'ENOENT')) continue; throw renameError; }
      await unlink(stale);
      continue;
    }
    const recoveryToken = randomUUID();
    try {
      await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, host: hostname(), expectedToken, recoveryToken, startedAt: new Date().toISOString() }));
      return recoveryToken;
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    } finally { await handle.close(); }
  }
  throw new Error('Recovery guard changed repeatedly; refusing takeover');
}

async function releaseRecoveryGuard(path: string, recoveryToken: string): Promise<void> {
  const guard = parseRecoveryGuard(JSON.parse(await readFile(path, 'utf8')));
  if (guard.recoveryToken !== recoveryToken || guard.pid !== process.pid || guard.host !== hostname()) throw new Error('Recovery guard ownership changed');
  await unlink(path);
}

async function clearCompletedRecoveryGuard(path: string): Promise<void> {
  let guard: RecoveryGuard;
  try { guard = parseRecoveryGuard(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (codeIs(error, 'ENOENT')) return; throw error; }
  if (guard.host !== hostname()) throw new Error('Device recovery owner is unknown; refusing new operation');
  try { process.kill(guard.pid, 0); throw new Error('Device recovery is active'); }
  catch (ownerError) {
    if (ownerError instanceof Error && ownerError.message === 'Device recovery is active') throw ownerError;
    if (!codeIs(ownerError, 'ESRCH')) throw new Error('Device recovery owner is unknown; refusing new operation');
  }
  const stale = `${path}.stale-${randomUUID()}`;
  try { await rename(path, stale); }
  catch (error) { if (codeIs(error, 'ENOENT')) return; throw error; }
  await unlink(stale);
}
export async function inspectDeviceLock(deviceId: string, directory = lockDirectory()): Promise<{ lease: DeviceLease; owner: 'alive' | 'dead' | 'unknown' } | null> {
  let lease: DeviceLease;
  try { lease = JSON.parse(await readFile(leasePath(deviceId, directory), 'utf8')) as DeviceLease; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!lease || lease.version !== 1 && lease.version !== 2 || lease.deviceId !== deviceId || typeof lease.token !== 'string' || !/^[a-f0-9-]{36}$/.test(lease.token) || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || typeof lease.host !== 'string' || typeof lease.startedAt !== 'string' || !Number.isFinite(Date.parse(lease.startedAt))) throw new Error('Invalid device lease; refusing recovery');
  if (lease.runDirectory !== undefined && (typeof lease.runDirectory !== 'string' || !isAbsolute(lease.runDirectory))) throw new Error('Invalid lease run directory');
  if (lease.recoveredFrom !== undefined && (!lease.recoveredFrom || typeof lease.recoveredFrom.token !== 'string' || !/^[a-f0-9-]{36}$/.test(lease.recoveredFrom.token) || lease.recoveredFrom.token === lease.token || lease.recoveredFrom.runDirectory !== undefined && (typeof lease.recoveredFrom.runDirectory !== 'string' || !isAbsolute(lease.recoveredFrom.runDirectory)))) throw new Error('Invalid predecessor lease metadata');
  if (lease.processToken !== undefined && (typeof lease.processToken !== 'string' || !/^[a-f0-9-]{36}$/.test(lease.processToken))) throw new Error('Invalid lease process token');
  if (lease.cleanupRequired !== undefined && (!lease.runDirectory || lease.cleanupRequired.runDirectory !== lease.runDirectory || !Number.isFinite(Date.parse(lease.cleanupRequired.recordedAt)) || lease.cleanupRequired.reason !== undefined && !['explicit', 'operation-exit', 'nested-exit'].includes(lease.cleanupRequired.reason))) throw new Error('Invalid cleanup-required lease metadata');
  if (lease.host !== hostname()) return { lease, owner: 'unknown' };
  try { process.kill(lease.pid, 0); return { lease, owner: 'alive' }; }
  catch (error) {
    return { lease, owner: error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH' ? 'dead' : 'unknown' };
  }
}

/** Bind recovery evidence before any Flow side effects, only from the owning scope. */
export async function bindDeviceLockRun(deviceId: string, runDirectory: string, directory = lockDirectory(), scope?: 'android-flow'): Promise<void> {
  const path = leasePath(deviceId, directory);
  if (!held.getStore()?.get(path) || active.get(path) !== held.getStore()?.get(path)) throw new Error('Device lease is not held by this operation');
  const state = await inspectDeviceLock(deviceId, directory);
  if (!state || state.lease.token !== held.getStore()?.get(path) || state.lease.pid !== process.pid || state.lease.host !== hostname() || state.lease.processToken !== processToken) throw new Error('Device lease owner changed');
  const sourcePlaceholder = state.lease.preparationScope === 'android-flow' &&
    !!state.lease.recoveredFrom?.runDirectory && state.lease.runDirectory === state.lease.recoveredFrom.runDirectory;
  if (state.lease.runDirectory && !sourcePlaceholder) throw new Error('Device lease already has a bound run');
  const root = await realpath(resolve(runDirectory));
  const lease = { ...state.lease, runDirectory: root };
  const intentPath = `${path}.binding-${lease.token}.json`;
  const intent = await open(intentPath, 'wx');
  try {
    await intent.writeFile(JSON.stringify({ version: 1, lease: state.lease, runDirectory: root, scope }));
    await intent.sync();
  } finally { await intent.close(); }
  // The immutable run copy permits matching a retained lease to its evidence.
  await writeFile(join(root, 'device-lease.json'), JSON.stringify(lease, null, 2), { flag: 'wx' });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(lease), { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 19 || !codeIs(error, 'EPERM') && !codeIs(error, 'EACCES') && !codeIs(error, 'EBUSY')) throw error;
        await delay(25);
      }
    }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function inspectPendingDeviceBinding(deviceId: string, lease: Readonly<DeviceLease>, directory = lockDirectory()) {
  const sourcePlaceholder = lease.preparationScope === 'android-flow' &&
    !!lease.recoveredFrom?.runDirectory && lease.runDirectory === lease.recoveredFrom.runDirectory;
  if (lease.runDirectory && !sourcePlaceholder) throw new Error('Device already has a bound run');
  let contents: string;
  try { contents = await readFile(`${leasePath(deviceId, directory)}.binding-${lease.token}.json`, 'utf8'); }
  catch (error) {
    if (codeIs(error, 'ENOENT')) throw Object.assign(new Error('No pending Android binding intent'), { code: 'APPVANTA_BINDING_ABSENT' });
    throw error;
  }
  const record = JSON.parse(contents);
  if (record.version !== 1 || record.scope !== 'android-flow' || !isDeepStrictEqual(record.lease, lease)
    || typeof record.runDirectory !== 'string' || !isAbsolute(record.runDirectory)
    || await realpath(record.runDirectory) !== record.runDirectory) throw new Error('Invalid pending Android binding');
  return { runDirectory: record.runDirectory as string, scope: 'android-flow' as const };
}

const admissionPath = (path: string, token: string) => `${path}.admission-${token}.jsonl`;
const resolutionIntentPath = (path: string, token: string, id: string) => `${admissionPath(path, token)}.resolving-${id}`;

async function initializeAdmissions(path: string, token: string, deviceId: string): Promise<void> {
  const handle = await open(admissionPath(path, token), 'wx');
  try {
    await handle.writeFile(JSON.stringify({ version: 1, sequence: 0, token, deviceId, kind: 'init' }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  admissions.set(nestedKey(path, token), { next: 1, tail: Promise.resolve() });
}

async function appendAdmission(path: string, token: string, deviceId: string, kind: 'pending' | 'resolved', id: string, operation: 'nested' | 'run-created-callback'): Promise<void> {
  const state = admissions.get(nestedKey(path, token));
  if (!state) throw new Error('Device admission journal is unavailable');
  const append = async () => {
    // A failed resolved write or fsync can leave readable bytes behind. Keep
    // this synced intent until the resolved record itself is synced, so
    // recovery refuses even if those bytes look complete.
    let intent: string | undefined;
    if (kind === 'resolved') {
      intent = resolutionIntentPath(path, token, id);
      const marker = await open(intent, 'wx');
      try {
        await marker.writeFile(JSON.stringify({ version: 1, token, deviceId, id }));
        await marker.sync();
      } finally { await marker.close(); }
    }
    const handle = await open(admissionPath(path, token), 'a');
    try {
      await handle.writeFile(JSON.stringify({ version: 1, sequence: state.next, token, deviceId, kind, id, operation }) + '\n');
      await handle.sync();
      state.next++;
    } finally { await handle.close(); }
    if (intent) await unlink(intent);
  };
  state.tail = state.tail.then(append);
  await state.tail;
}

/** Validate the complete token-specific journal before any device recovery command. */
export async function inspectDeviceAdmissionJournal(lease: Readonly<DeviceLease>, directory = lockDirectory()): Promise<'legacy' | 'resolved' | 'unresolved'> {
  if (lease.version === 1) return 'legacy';
  const path = leasePath(lease.deviceId, directory);
  const journal = admissionPath(path, lease.token);
  const contents = await readFile(journal, 'utf8');
  const intents = (await readdir(resolve(directory))).filter(name => name.startsWith(`${basename(journal)}.resolving-`));
  if (!contents.endsWith('\n')) throw new Error('Incomplete device admission journal');
  const lines = contents.slice(0, -1).split('\n');
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const [sequence, line] of lines.entries()) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error('Malformed device admission journal'); }
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 || record.sequence !== sequence || record.token !== lease.token || record.deviceId !== lease.deviceId) throw new Error('Foreign or out-of-order device admission journal');
    if (sequence === 0) {
      if (record.kind !== 'init' || Object.keys(record).length !== 5) throw new Error('Invalid device admission journal initialization');
      continue;
    }
    if ((record.kind !== 'pending' && record.kind !== 'resolved') || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id) || (record.operation !== 'nested' && record.operation !== 'run-created-callback') || Object.keys(record).length !== 7) throw new Error('Invalid device admission journal record');
    if (record.kind === 'pending') {
      if (seen.has(record.id)) throw new Error('Duplicate device admission journal operation');
      seen.add(record.id);
      pending.set(record.id, record.operation);
    } else {
      if (pending.get(record.id) !== record.operation) throw new Error('Unmatched device admission journal resolution');
      pending.delete(record.id);
    }
  }
  return pending.size || intents.length ? 'unresolved' : 'resolved';
}

/** Admit work before invoking it. A resolved record means the caller's success
 * postcondition holds: nested operations must restore and verify any external
 * state they change before returning. Failed or uncertain work must reject.
 */
async function admittedOperation<T>(deviceId: string, operation: () => Promise<T>, directory: string, operationKind: 'nested' | 'run-created-callback'): Promise<T> {
  const path = leasePath(deviceId, directory);
  const token = held.getStore()?.get(path);
  if (!token || active.get(path) !== token || closing.get(path) === token) throw new Error('Device lease is not held by an active operation');
  const key = nestedKey(path, token);
  const work = (async () => {
    const state = await inspectDeviceLock(deviceId, directory);
    if (!state || state.lease.token !== token || state.lease.processToken !== processToken || state.lease.cleanupRequired || closing.get(path) === token) throw new Error('Device lease changed before admission');
    const id = randomUUID();
    await appendAdmission(path, token, deviceId, 'pending', id, operationKind);
    if (closing.get(path) === token) throw new Error('Device operation closed during admission');
    const result = await operation();
    await appendAdmission(path, token, deviceId, 'resolved', id, operationKind);
    return result;
  })();
  let pending = nested.get(key);
  if (!pending) { pending = new Set(); nested.set(key, pending); }
  pending.add(work);
  try { return await work; }
  catch (error) {
    if (operationKind === 'nested') nestedFailed.add(key);
    else admissionFailed.add(key);
    throw error;
  }
  finally { pending.delete(work); }
}

/** Admit a metadata-only callback. It must not change device or other external
 * state; successful completion means its metadata has been durably persisted.
 */
export async function withDeviceLockAdmission<T>(deviceId: string, operation: () => Promise<T>, directory = lockDirectory()): Promise<T> {
  return admittedOperation(deviceId, operation, directory, 'run-created-callback');
}

/** Persist an unsafe Flow finalization before its owning lock scope exits. */
export async function retainDeviceLockForCleanup(deviceId: string, runDirectory: string, directory = lockDirectory(), reason: 'explicit' | 'operation-exit' | 'nested-exit' = 'explicit'): Promise<void> {
  const path = leasePath(deviceId, directory);
  const token = held.getStore()?.get(path);
  if (!token || active.get(path) !== token) throw new Error('Device lease is not held by an active operation');
  // A failed marker write must not make the owning wrapper silently release the lease.
  unsafe.set(path, token);
  const state = await inspectDeviceLock(deviceId, directory);
  if (!state || state.lease.token !== token || active.get(path) !== token || state.lease.pid !== process.pid || state.lease.host !== hostname() || state.lease.processToken !== processToken || state.lease.runDirectory !== await realpath(resolve(runDirectory))) throw new Error('Bound device lease changed');
  const next: DeviceLease = { ...state.lease, cleanupRequired: { runDirectory: state.lease.runDirectory, recordedAt: new Date().toISOString(), reason } };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(next), { flag: 'wx' }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (!codeIs(error, 'ENOENT')) throw error; }); }
  await appendFile(join(state.lease.runDirectory, 'device-lease-recovery.jsonl'), JSON.stringify({ version: 1, token: state.lease.token, deviceId, status: 'cleanup-required', reason, at: next.cleanupRequired!.recordedAt }) + '\n');
}

/** Recovery handlers must restore and verify all recorded side effects before resolving.
 * Keep the abandoned lease in place throughout cleanup; never age-expire a lease.
 * PID reuse is conservative: a live reused PID blocks recovery.
 */
export async function recoverDeviceLock<T>(deviceId: string, expectedToken: string, cleanup: (lease: Readonly<DeviceLease>) => Promise<T>, directory = lockDirectory()): Promise<T> {
  const path = leasePath(deviceId, directory);
  const requireRecoverableOwner = async () => {
    const state = await inspectDeviceLock(deviceId, directory);
    if (!state || state.lease.token !== expectedToken) throw new Error('Device lease changed or missing');
    const retainedHere = state.owner === 'alive' && state.lease.pid === process.pid && state.lease.host === hostname() && state.lease.processToken === processToken && !active.has(path);
    if (state.owner !== 'dead' && !retainedHere) throw new Error(`Device lease owner is ${state.owner}; refusing recovery`);
    return state.lease;
  };
  const initial = await requireRecoverableOwner();
  const guardPath = path + '.recovery';
  const recoveryToken = await acquireRecoveryGuard(guardPath, expectedToken, initial.recoveredFrom?.token);
  try {
    const lease = await requireRecoverableOwner();
    const result = await cleanup(Object.freeze(lease));
    await requireRecoverableOwner();
    if (lease.runDirectory) await appendFile(join(lease.runDirectory, 'device-lease-recovery.jsonl'), JSON.stringify({ version: 1, token: lease.token, deviceId, status: 'verified-cleanup', at: new Date().toISOString() }) + '\n');
    await unlink(path);
    // A failed lease unlink must leave its token journal available for retry.
    // Once the lease is gone, journal removal is only orphan housekeeping.
    if (lease.version === 2) await unlink(admissionPath(path, lease.token)).catch(() => {});
    return result;
  } finally {
    await releaseRecoveryGuard(guardPath, recoveryToken);
  }
}

/** Atomically transfers a cleaned abandoned device to a continuation without unlocking it. */
export async function continueRecoveredDevice<T>(deviceId: string, expectedToken: string,
  cleanup: (lease: Readonly<DeviceLease>) => Promise<void>, operation: () => Promise<T>, directory = lockDirectory(), preparationScope?: 'android-flow'): Promise<T> {
  const path = leasePath(deviceId, directory);
  const requireDead = async () => {
    const state = await inspectDeviceLock(deviceId, directory);
    if (!state || state.lease.token !== expectedToken || state.owner !== 'dead') throw new Error('Abandoned device lease changed or owner is not dead');
    return state.lease;
  };
  const initial = await requireDead();
  const guardPath = path + '.recovery';
  const guardToken = await acquireRecoveryGuard(guardPath, expectedToken, initial.recoveredFrom?.token);
  const token = randomUUID();
  let transferred = false;
  try {
    const lease = await requireDead();
    await cleanup(Object.freeze(lease));
    await requireDead();
    const sourceRun = lease.runDirectory ?? lease.recoveredFrom?.runDirectory;
    const next: DeviceLease = { version: 2, token, deviceId, pid: process.pid, host: hostname(), processToken, startedAt: new Date().toISOString(), ...(sourceRun ? { runDirectory: sourceRun } : {}), recoveredFrom: { token: lease.token, ...(sourceRun ? { runDirectory: sourceRun } : {}) }, ...(preparationScope ? { preparationScope } : {}) };
    const temporary = `${path}.${token}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { flag: 'wx' });
    await rename(temporary, path);
    transferred = true;
  } finally {
    await releaseRecoveryGuard(guardPath, guardToken);
  }
  if (!transferred) throw new Error('Device continuation ownership was not transferred');
  await initializeAdmissions(path, token, deviceId);
  active.set(path, token);
  let failed = false;
  try { return await held.run(new Map([...(held.getStore() ?? []), [path, token]]), operation); }
  catch (error) { failed = true; throw error; }
  finally { await held.run(new Map([...(held.getStore() ?? []), [path, token]]), () => finishOwnedOperation(deviceId, path, token, directory, failed)); }
}
async function finishOwnedOperation(deviceId: string, path: string, token: string, directory: string, failed: boolean): Promise<void> {
  closing.set(path, token);
  try {
    while (nested.get(nestedKey(path, token))?.size) await Promise.allSettled([...nested.get(nestedKey(path, token))!]);
    let current = await inspectDeviceLock(deviceId, directory);
    if (!current || current.lease.token !== token || current.lease.pid !== process.pid || current.lease.processToken !== processToken) throw new Error('Device lease ownership changed');
    const admissionResolved = await inspectDeviceAdmissionJournal(current.lease, directory).then(state => state === 'resolved', () => false);
    // Nested work can start before a run is bound. Its failed admission or
    // execution must keep the lease even when no run-local marker can exist.
    const mustRetain = !admissionResolved || nestedFailed.has(nestedKey(path, token)) || admissionFailed.has(nestedKey(path, token)) || unsafe.get(path) === token || !!current.lease.runDirectory && failed;
    const nestedExit = nestedFailed.has(nestedKey(path, token));
    if (mustRetain && current.lease.runDirectory && (!current.lease.cleanupRequired || nestedExit && current.lease.cleanupRequired.reason !== 'nested-exit')) {
      const reason = nestedExit ? 'nested-exit' : unsafe.get(path) === token ? 'explicit' : 'operation-exit';
      try { await retainDeviceLockForCleanup(deviceId, current.lease.runDirectory, directory, reason); }
      catch (error) { throw new AggregateError([error], `Device lease ${token} remains exclusive; recover with recoverDeviceLock after verified cleanup (${path})`); }
      current = await inspectDeviceLock(deviceId, directory);
      if (!current || current.lease.token !== token) throw new Error('Device lease ownership changed');
    }
    if (!current.lease.cleanupRequired && !mustRetain) {
      await unlink(path);
      await unlink(admissionPath(path, token)).catch(() => {});
    }
    if (mustRetain && !current.lease.runDirectory) throw new Error(`Device lease ${token} remains exclusive; cleanup recovery requires a bound run (${path})`);
  } finally {
    if (active.get(path) === token) active.delete(path);
    if (closing.get(path) === token) closing.delete(path);
    if (unsafe.get(path) === token) unsafe.delete(path);
    nested.delete(nestedKey(path, token));
    nestedFailed.delete(nestedKey(path, token));
    admissionFailed.delete(nestedKey(path, token));
    admissions.delete(nestedKey(path, token));
  }
}
/** Local-host lease shared by CLI and MCP, including different working directories.
 * Never steal an abandoned lease: device/proxy state may need recovery first.
 * A nested operation's successful return certifies that it restored and
 * verified any external state it changed; uncertain restoration must reject.
 */
export async function withDeviceLock<T>(deviceId: string, operation: () => Promise<T>, directory = lockDirectory()): Promise<T> {
  const path = leasePath(deviceId, directory);
  const scopedToken = held.getStore()?.get(path);
  if (scopedToken && active.get(path) === scopedToken) {
    if (closing.get(path) === scopedToken) throw new Error(`Device lease is closing; nested admission refused: ${deviceId}`);
    const state = await inspectDeviceLock(deviceId, directory);
    if (active.get(path) === scopedToken && closing.get(path) !== scopedToken && state?.lease.token === scopedToken && state.lease.pid === process.pid && state.lease.host === hostname() && state.lease.processToken === processToken) {
      if (state.lease.cleanupRequired) throw new Error(`Device busy: ${deviceId}; cleanup required`);
      const key = nestedKey(path, scopedToken);
      try { return await admittedOperation(deviceId, operation, directory, 'nested'); }
      catch (error) { nestedFailed.add(key); throw error; }
    }
    // This call began while the scoped owner was active. Losing that owner
    // during the awaited inspection cannot turn it into a new acquisition.
    throw new Error(`Device lease changed before nested admission: ${deviceId}`);
  }
  await mkdir(resolve(directory), { recursive: true });
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new Error(`Device busy: ${deviceId}; lease: ${path}`);
    throw error;
  }
  try { await clearCompletedRecoveryGuard(path + '.recovery'); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  const token = randomUUID();
  let failed = false;
  try {
    await handle.writeFile(JSON.stringify({ version: 2, token, deviceId, pid: process.pid, host: hostname(), processToken, startedAt: new Date().toISOString() }));
    // File existence is the lease. Close the handle so Windows can atomically
    // replace its metadata when binding a run; never remove the lock here.
    await handle.close();
    await initializeAdmissions(path, token, deviceId);
    active.set(path, token);
    try { return await held.run(new Map([...(held.getStore() ?? []), [path, token]]), operation); }
    catch (error) { failed = true; throw error; }
  } finally {
    await handle.close();
    if (active.get(path) === token) await held.run(new Map([...(held.getStore() ?? []), [path, token]]), () => finishOwnedOperation(deviceId, path, token, directory, failed));
  }
}
