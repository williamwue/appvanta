import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { AuditLog, parseFlow, recoverDeviceLock, continueRecoveredDevice, inspectPendingDeviceBinding, inspectDeviceAdmissionJournal, inspectInterruptedAndroidFlowAdmission, inspectUnstartedDeviceTransfer, type DeviceLease } from '@appvanta/core';
import { AdbDriver } from './adb-driver.js';
import { recoverFileFixtures } from './file-fixtures.js';
import { recoverImeFixture } from './ime-fixture.js';
import { recoverAppOps } from './appops-fixture.js';
import { recoverCaptures } from './capture.js';
import { recoverNetworkSession } from './network-session.js';
import { recoverRuntimePermissions } from './permission-fixture.js';
import { recoverEmulatorShakes } from './emulator-sensors.js';

/** Restore recorded external state, not business actions or execution progress. */
export async function recoverAndroidFlow(deviceId: string, expectedToken: string) {
  return recoverDeviceLock(deviceId, expectedToken, lease => recoverAndroidState(deviceId, lease));
}

export async function continueAndroidFlow<T>(deviceId: string, expectedToken: string, operation: (sourceRun: string) => Promise<T>, beforeRecovery?: (lease: Readonly<DeviceLease>) => Promise<void>, signal?: AbortSignal, onCancelledBeforeTransfer?: () => Promise<void>) {
  let sourceRun: string | undefined;
  return continueRecoveredDevice(deviceId, expectedToken, async lease => {
    await beforeRecovery?.(lease);
    sourceRun = (await recoverAndroidState(deviceId, lease)).runDirectory;
    if (signal?.aborted) await onCancelledBeforeTransfer?.();
    signal?.throwIfAborted();
  }, async () => {
    if (!sourceRun) throw new Error('Recovered source run is missing');
    return operation(sourceRun);
  }, undefined, 'android-flow');
}

async function requireManualRecovery(deviceId: string, lease: Readonly<DeviceLease>, root: string, reason: string, cause?: unknown): Promise<never> {
  const error = Object.assign(new Error(`Manual review required: ${reason}. Lease retained: ${root}`, cause === undefined ? undefined : { cause }), { code: 'APPVANTA_MANUAL_RECOVERY_REQUIRED' });
  try {
    await new AuditLog(join(root, 'audit.jsonl')).append({ timestamp: new Date().toISOString(), actor: `appvanta-process:${process.pid}`, action: 'recover-flow', target: deviceId, outcome: 'failed', metadata: { token: lease.token, reason } });
  } catch (auditError) {
    throw Object.assign(new AggregateError([error, auditError], `${error.message}; recovery refusal audit could not be written`), { code: 'APPVANTA_MANUAL_RECOVERY_REQUIRED' });
  }
  throw error;
}

async function recoverAndroidState(deviceId: string, lease: Readonly<DeviceLease>) {
    let interruptedFlow: Awaited<ReturnType<typeof inspectInterruptedAndroidFlowAdmission>> | undefined;
    if (lease.version === 2) {
      try {
        const state = await inspectDeviceAdmissionJournal(lease);
        if (state !== 'resolved') interruptedFlow = await inspectInterruptedAndroidFlowAdmission(lease);
      } catch (error) {
        let auditRoot = lease.runDirectory ?? lease.recoveredFrom?.runDirectory;
        if (!auditRoot) {
          try { auditRoot = (await inspectPendingDeviceBinding(deviceId, lease)).runDirectory; }
          catch { auditRoot = process.env.APPVANTA_LOCK_DIRECTORY ?? join(homedir(), '.appvanta', 'device-locks'); }
        }
        const reason = lease.cleanupRequired?.reason === 'nested-exit'
          ? 'a nested operation exited with unverified side effects or admission evidence is invalid'
          : 'onRunCreated or nested operation admission journal is missing, invalid, or unresolved';
        await requireManualRecovery(deviceId, lease, auditRoot, reason, error);
      }
    }
    // A transferred Android lease keeps the predecessor run as a source
    // placeholder until the successor run binds. Treat that placeholder as
    // recoverable evidence, while still validating any in-flight binding intent.
    const sourcePlaceholder = lease.preparationScope === 'android-flow' &&
      !!lease.recoveredFrom?.runDirectory && lease.runDirectory === lease.recoveredFrom.runDirectory;
    if (sourcePlaceholder) {
      const source = await realpath(lease.recoveredFrom!.runDirectory!);
      if (source !== lease.recoveredFrom!.runDirectory) throw new Error('Continuation source path changed');
      const predecessor = JSON.parse(await readFile(join(source, 'device-lease.json'), 'utf8'));
      if (predecessor.deviceId !== deviceId || predecessor.runDirectory !== source)
        throw new Error('Continuation predecessor binding mismatch');
      if (predecessor.token !== lease.recoveredFrom!.token)
        await inspectUnstartedDeviceTransfer(predecessor, lease.token);
      let pending;
      try { pending = await inspectPendingDeviceBinding(deviceId, lease); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'APPVANTA_BINDING_ABSENT') throw error;
      }
      if (!pending) {
        const evidence = join(source, `preparation-recovery-${randomUUID()}.json`);
        const result = { status: 'recovered', scope: 'pre-continuation-binding', runDirectory: source, evidence, steps: [] };
        await writeFile(evidence, JSON.stringify({ ...result, lease, reason: 'Android continuation cleanup completed before successor binding' }, null, 2), { flag: 'wx' });
        return result;
      }
      const metadata = JSON.parse(await readFile(join(pending.runDirectory, 'run.json'), 'utf8'));
      if (metadata.status !== 'planned') throw new Error('Unbound run is no longer in planned state');
      for (const name of ['flow.json', 'progress.json', 'steps.jsonl']) {
        try { await readFile(join(pending.runDirectory, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        throw new Error('Unbound run contains execution evidence; refusing release');
      }
      const evidence = join(pending.runDirectory, `binding-recovery-${randomUUID()}.json`);
      const result = { status: 'recovered', scope: 'pre-flow-binding', runDirectory: pending.runDirectory, evidence, steps: [] };
      await writeFile(evidence, JSON.stringify({ ...result, lease, reason: 'Persisted Android successor binding intent; executeFlow did not begin' }, null, 2), { flag: 'wx' });
      return result;
    }
    if (!lease.runDirectory) {
      let pending;
      try { pending = await inspectPendingDeviceBinding(deviceId, lease); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'APPVANTA_BINDING_ABSENT'
          || lease.preparationScope !== 'android-flow' || !lease.recoveredFrom?.runDirectory) throw error;
        const source = await realpath(lease.recoveredFrom.runDirectory);
        if (source !== lease.recoveredFrom.runDirectory) throw new Error('Continuation source path changed');
        const predecessor = JSON.parse(await readFile(join(source, 'device-lease.json'), 'utf8'));
        if (predecessor.token !== lease.recoveredFrom.token || predecessor.deviceId !== deviceId
          || predecessor.runDirectory !== source) throw new Error('Continuation predecessor binding mismatch');
        const evidence = join(source, `preparation-recovery-${randomUUID()}.json`);
        const result = { status: 'recovered', scope: 'pre-continuation-binding', runDirectory: source, evidence, steps: [] };
        await writeFile(evidence, JSON.stringify({ ...result, lease, reason: 'Android continuation cleanup completed before transfer; no successor binding intent exists' }, null, 2), { flag: 'wx' });
        return result;
      }
      const metadata = JSON.parse(await readFile(join(pending.runDirectory, 'run.json'), 'utf8'));
      if (metadata.status !== 'planned') throw new Error('Unbound run is no longer in planned state');
      for (const name of ['flow.json', 'progress.json', 'steps.jsonl']) {
        try { await readFile(join(pending.runDirectory, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        throw new Error('Unbound run contains execution evidence; refusing release');
      }
      const evidence = join(pending.runDirectory, `binding-recovery-${randomUUID()}.json`);
      const result = { status: 'recovered', scope: 'pre-flow-binding', runDirectory: pending.runDirectory, evidence, steps: [] };
      await writeFile(evidence, JSON.stringify({ ...result, lease, reason: 'Persisted Android binding intent; executeFlow did not begin' }, null, 2), { flag: 'wx' });
      return result;
    }
    const root = await realpath(lease.runDirectory);
    if (root !== lease.runDirectory) throw new Error('Bound run path changed');
    const copy = JSON.parse(await readFile(join(root, 'device-lease.json'), 'utf8'));
    for (const key of ['version', 'token', 'deviceId', 'pid', 'host', 'startedAt', 'runDirectory'] as const) {
      if (copy[key] !== lease[key]) throw new Error('Run evidence does not match device lease');
    }
    if (lease.cleanupRequired?.reason === 'nested-exit') await requireManualRecovery(deviceId, lease, root, 'a nested operation exited with unverified side effects');
    let callbackMarker = false;
    try {
      await readFile(join(root, 'pre-flow-failure.json'));
      callbackMarker = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await requireManualRecovery(deviceId, lease, root, 'pre-Flow callback evidence cannot be verified', error);
    }
    if (callbackMarker) await requireManualRecovery(deviceId, lease, root, 'onRunCreated failed and may have changed device or external state');
    let flowContents: string;
    try { flowContents = await readFile(join(root, 'flow.json'), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await requireManualRecovery(deviceId, lease, root, 'bound run has no flow.json; onRunCreated may have changed device or external state', error);
      }
      throw error;
    }
    const flow = parseFlow(JSON.parse(flowContents));
    const device = JSON.parse(await readFile(join(root, 'device.json'), 'utf8'));
    if (device.id !== deviceId) throw new Error('Run device does not match lease');
    const driver = new AdbDriver({ artifactsDirectory: join(root, 'recovery-artifacts') });
    const connected = (await driver.listDevices()).find(item => item.id === deviceId && item.status === 'online');
    if (!connected) throw new Error('Recovery device is offline');
    const current = await driver.deviceEnvironment(connected.id);
    for (const key of ['model', 'osVersion'] as const) {
      if (device[key] !== current[key]) throw new Error(`Recovery device environment changed: ${key}`);
    }
    const directory = join(root, 'recovery');
    await mkdir(directory, { recursive: true });
    const attempt = randomUUID();
    const audit = new AuditLog(join(root, 'audit.jsonl'));
    const steps: { fixture: string; status: string; error?: string }[] = [];
    const save = () => writeFile(join(directory, `${attempt}.json`), JSON.stringify({ version: 1, deviceId, token: lease.token, scope: 'environment-cleanup', steps }, null, 2));
    const jobs: [string, boolean, () => Promise<void>][] = [
      ['emulator-sensors', true, () => recoverEmulatorShakes('adb', deviceId, join(root, 'fixtures', 'emulator-sensors'))],
      ['capture', !!flow.capture, async () => { await recoverCaptures('adb', deviceId, root); }],
      ['network', !!flow.network, async () => { await recoverNetworkSession('adb', deviceId, root); }],
      ['appops', !!flow.appOps, () => recoverAppOps(deviceId, root)],
      ['runtime-permissions', !!flow.permissions, () => recoverRuntimePermissions(deviceId, root)],
      ['input-method', !!flow.inputMethod, () => recoverImeFixture(deviceId, root)],
      ['files', !!flow.files, () => recoverFileFixtures(deviceId, root)],
    ];
    for (const [fixture, configured, restore] of jobs) {
      if (!configured) continue;
      try {
        await audit.append({ timestamp: new Date().toISOString(), actor: `appvanta-process:${process.pid}`, action: 'recover-fixture', target: fixture, outcome: 'started' });
        await restore();
        steps.push({ fixture, status: 'passed' });
      } catch (error) { steps.push({ fixture, status: 'failed', error: String(error) }); }
      await save();
      const last = steps.at(-1)!;
      await audit.append({ timestamp: new Date().toISOString(), actor: `appvanta-process:${process.pid}`, action: 'recover-fixture', target: fixture, outcome: last.status === 'passed' ? 'passed' : 'failed', ...(last.error ? { metadata: { error: last.error } } : {}) });
    }
    if (steps.some(step => step.status === 'failed')) throw new Error(`Environment recovery incomplete; lease retained; evidence: ${join(directory, `${attempt}.json`)}`);
    await save();
    if (interruptedFlow) {
      const verified = await inspectInterruptedAndroidFlowAdmission(lease);
      if (verified.admissionId !== interruptedFlow.admissionId || verified.runDirectory !== interruptedFlow.runDirectory ||
        verified.journalDigestSha256 !== interruptedFlow.journalDigestSha256)
        throw new Error('Interrupted Android Flow admission changed during cleanup');
      await audit.append({ timestamp: new Date().toISOString(), actor: `appvanta-process:${process.pid}`,
        action: 'recover-interrupted-flow-admission', target: deviceId, outcome: 'passed',
        metadata: { ...verified, token: lease.token, cleanupEvidence: join(directory, `${attempt}.json`), scope: 'environment-cleanup-only' } });
    }
    return { status: 'recovered', scope: 'environment-cleanup', runDirectory: root, evidence: join(directory, `${attempt}.json`), steps };
}
