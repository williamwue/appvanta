import { randomUUID } from 'node:crypto';
import { open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectDeviceLock } from './device-lock.js';
import { parseCondition, parseFlow } from './flow-schema.js';
import { previewUncertainTaskStep } from './uncertain-step-preview.js';
import { TaskStore } from './tasks.js';
import { readContinuationLineage } from './continuation-lineage.js';

const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const taskId = (value: unknown): value is string => typeof value === 'string' && /^task-[a-f0-9-]{36}$/.test(value);
const instructionId = (value: unknown): value is string => typeof value === 'string' && /^instruction-[a-f0-9-]{36}$/.test(value);
const label = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const exactKeys = (value: Record<string, unknown>, expected: string[]) =>
  isDeepStrictEqual(Object.keys(value).sort(), expected.sort());

function checkpoint(value: unknown) {
  const condition = parseCondition(value);
  if (condition.kind === 'ui-changed' || condition.kind === 'screen-stable')
    throw new Error('Adjudication requires a checkpoint describing expected application state');
  return condition;
}

function validLeaseSnapshot(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  if (!Object.keys(lease).every(key => ['version', 'token', 'deviceId', 'pid', 'host', 'startedAt',
    'runDirectory', 'recoveredFrom', 'preparationScope', 'processToken', 'cleanupRequired'].includes(key))
    || lease.version !== 1 && lease.version !== 2 || !uuid(lease.token) || typeof lease.deviceId !== 'string'
    || !Number.isSafeInteger(lease.pid) || Number(lease.pid) < 1
    || typeof lease.host !== 'string' || typeof lease.startedAt !== 'string'
    || !Number.isFinite(Date.parse(lease.startedAt))
    || lease.runDirectory !== undefined && (typeof lease.runDirectory !== 'string' || !isAbsolute(lease.runDirectory))
    || lease.preparationScope !== undefined && lease.preparationScope !== 'android-flow'
    || lease.processToken !== undefined && !uuid(lease.processToken)) return false;
  if (lease.recoveredFrom !== undefined) {
    if (!lease.recoveredFrom || typeof lease.recoveredFrom !== 'object' || Array.isArray(lease.recoveredFrom)) return false;
    const predecessor = lease.recoveredFrom as Record<string, unknown>;
    if (!Object.keys(predecessor).every(key => ['token', 'runDirectory'].includes(key))
      || !uuid(predecessor.token) || predecessor.token === lease.token
      || predecessor.runDirectory !== undefined
        && (typeof predecessor.runDirectory !== 'string' || !isAbsolute(predecessor.runDirectory))) return false;
  }
  if (lease.cleanupRequired !== undefined) {
    if (!lease.cleanupRequired || typeof lease.cleanupRequired !== 'object' || Array.isArray(lease.cleanupRequired)) return false;
    const cleanup = lease.cleanupRequired as Record<string, unknown>;
    if (!Object.keys(cleanup).every(key => ['runDirectory', 'recordedAt', 'reason'].includes(key))
      || !lease.runDirectory || cleanup.runDirectory !== lease.runDirectory
      || typeof cleanup.recordedAt !== 'string' || !Number.isFinite(Date.parse(cleanup.recordedAt))
      || cleanup.reason !== undefined && !['explicit', 'operation-exit', 'nested-exit'].includes(cleanup.reason as string)) return false;
  }
  return true;
}

export interface UncertainStepDecisionInput {
  readonly expectedPreviewDigestSha256: string;
  readonly expectedLeaseToken: string;
  readonly operator: string;
  readonly reason: string;
  readonly verdict: 'unresolved' | 'postcondition-verified-skip';
  readonly postconditionCheckpoint?: unknown;
}

/** Historical intent only. A future executor must revalidate the checkpoint under a guarded lease transfer. */
export async function recordUncertainStepAdjudication(store: TaskStore, successorTaskId: string,
  input: UncertainStepDecisionInput, lockDirectory?: string) {
  // Capture every caller-owned field before the first await. The checkpoint parser
  // returns a detached copy of nested targets and arrays.
  const decisionInput = {
    expectedPreviewDigestSha256: input.expectedPreviewDigestSha256, expectedLeaseToken: input.expectedLeaseToken,
    operator: input.operator, reason: input.reason, verdict: input.verdict,
    postconditionCheckpoint: input.postconditionCheckpoint,
  };
  if (!hex(decisionInput.expectedPreviewDigestSha256) || !uuid(decisionInput.expectedLeaseToken)
    || !label(decisionInput.operator, 120) || !label(decisionInput.reason, 1000)
    || !['unresolved', 'postcondition-verified-skip'].includes(decisionInput.verdict)) throw new Error('Invalid adjudication input');
  if (decisionInput.verdict === 'unresolved' && decisionInput.postconditionCheckpoint !== undefined)
    throw new Error('Unresolved adjudication cannot include a checkpoint');
  if (decisionInput.verdict === 'postcondition-verified-skip' && decisionInput.postconditionCheckpoint === undefined)
    throw new Error('Skip intent requires a postcondition checkpoint');
  const condition = decisionInput.verdict === 'postcondition-verified-skip' ? checkpoint(decisionInput.postconditionCheckpoint) : null;
  const before = await previewUncertainTaskStep(store, successorTaskId);
  if (before.previewDigestSha256 !== decisionInput.expectedPreviewDigestSha256) throw new Error('Adjudication preview changed');
  const task = await store.get(successorTaskId);
  if (task.status !== 'interrupted' || await store.cancellationRequested(successorTaskId)
    || await store.cancellationRequested(before.sourceTaskId)) throw new Error('Adjudication task or cancellation state changed');
  const firstLease = await inspectDeviceLock(task.deviceId, lockDirectory);
  if (!firstLease || firstLease.owner !== 'dead' || !validLeaseSnapshot(firstLease.lease)
    || firstLease.lease.token !== decisionInput.expectedLeaseToken
    || !firstLease.lease.runDirectory || await realpath(firstLease.lease.runDirectory) !== before.runDirectory)
    throw new Error('Adjudication requires the exact dead-owner lease bound to the successor run');
  const { claim } = await readContinuationLineage(store, successorTaskId);
  if (!uuid(claim.id)) throw new Error('Invalid continuation claim ID');
  const record = {
    version: 1 as const, id: randomUUID(), createdAt: new Date().toISOString(),
    sourceTaskId: before.sourceTaskId, successorTaskId, claimId: claim.id,
    sourceRun: before.sourceRun, runDirectory: before.runDirectory,
    activeStepIndex: before.activeStepIndex, activeIdentity: before.activeIdentity,
    activeStep: before.activeStep, revision: before.revision,
    previewDigestSha256: before.previewDigestSha256,
    lease: { deviceId: task.deviceId, token: firstLease.lease.token, runDirectory: firstLease.lease.runDirectory,
      snapshot: firstLease.lease },
    operator: decisionInput.operator, reason: decisionInput.reason, verdict: decisionInput.verdict,
    postconditionCheckpoint: condition, resumeAuthorized: false as const,
  };
  // A final pre-write reread narrows the race window. The version 2 admission journal
  // is not resolved here: this records human intent only, never execution permission.
  // Filesystem reads and wx creation are separate operations, not atomic authorization.
  const immediatelyBefore = await previewUncertainTaskStep(store, successorTaskId);
  const leaseBefore = await inspectDeviceLock(task.deviceId, lockDirectory);
  if (!isDeepStrictEqual(before, immediatelyBefore) || !isDeepStrictEqual(firstLease, leaseBefore)
    || await store.cancellationRequested(successorTaskId) || await store.cancellationRequested(before.sourceTaskId))
    throw new Error('Adjudication state changed before write');
  const path = join(store.directory, successorTaskId, 'uncertain-step-adjudication.json');
  const handle = await open(path, 'wx');
  try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  const after = await previewUncertainTaskStep(store, successorTaskId);
  const finalLease = await inspectDeviceLock(task.deviceId, lockDirectory);
  if (!isDeepStrictEqual(before, after) || !isDeepStrictEqual(firstLease, finalLease)
    || await store.cancellationRequested(successorTaskId) || await store.cancellationRequested(before.sourceTaskId))
    throw new Error('Adjudication state changed after write; immutable decision retained for review');
  return record;
}

/** Reads an immutable decision as data; it never authorizes resumption. */
export async function readUncertainStepAdjudication(store: TaskStore, successorTaskId: string) {
  const value: unknown = JSON.parse(await readFile(join(store.directory, successorTaskId, 'uncertain-step-adjudication.json'), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid adjudication record');
  const r = value as Record<string, unknown>;
  const identity = r.activeIdentity as Record<string, unknown> | undefined;
  const lease = r.lease as Record<string, unknown> | undefined;
  const snapshot = lease?.snapshot;
  const validCheckpoint = r.verdict === 'unresolved' ? r.postconditionCheckpoint === null
    : r.verdict === 'postcondition-verified-skip' && r.postconditionCheckpoint !== null
      && isDeepStrictEqual(checkpoint(r.postconditionCheckpoint), r.postconditionCheckpoint);
  if (!exactKeys(r, ['version', 'id', 'createdAt', 'sourceTaskId', 'successorTaskId', 'claimId', 'sourceRun', 'runDirectory',
    'activeStepIndex', 'activeIdentity', 'activeStep', 'revision', 'previewDigestSha256', 'lease', 'operator', 'reason',
    'verdict', 'postconditionCheckpoint', 'resumeAuthorized'])
    || r.version !== 1 || !uuid(r.id) || typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt))
    || !taskId(r.sourceTaskId) || !taskId(r.successorTaskId) || r.successorTaskId !== successorTaskId || !uuid(r.claimId)
    || typeof r.sourceRun !== 'string' || !isAbsolute(r.sourceRun)
    || typeof r.runDirectory !== 'string' || !isAbsolute(r.runDirectory)
    || !Number.isSafeInteger(r.activeStepIndex) || Number(r.activeStepIndex) < 1
    || !Number.isSafeInteger(r.revision) || Number(r.revision) < 1 || !hex(r.previewDigestSha256)
    || !identity || !exactKeys(identity, ['flowIndex']) && !exactKeys(identity, ['instructionId'])
    || identity.flowIndex !== undefined && (!Number.isSafeInteger(identity.flowIndex) || Number(identity.flowIndex) < 0)
    || identity.instructionId !== undefined && !instructionId(identity.instructionId)
    || !r.activeStep || typeof r.activeStep !== 'object' || !lease || !validLeaseSnapshot(snapshot)
    || !exactKeys(lease, ['deviceId', 'token', 'runDirectory', 'snapshot'])
    || typeof lease.deviceId !== 'string' || !uuid(lease.token)
    || typeof lease.runDirectory !== 'string' || await realpath(lease.runDirectory) !== r.runDirectory
    || snapshot.token !== lease.token || snapshot.deviceId !== lease.deviceId
    || snapshot.runDirectory !== lease.runDirectory || !label(r.operator, 120) || !label(r.reason, 1000)
    || !validCheckpoint || r.resumeAuthorized !== false) throw new Error('Invalid adjudication record');
  parseFlow({ version: 1, name: 'Adjudicated active step', steps: [r.activeStep] });
  return value as typeof r & { resumeAuthorized: false };
}
