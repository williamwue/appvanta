import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectDeviceLock, inspectUnstartedDeviceTransfer, type DeviceLease } from './device-lock.js';
import { prepareAdjudicatedFlowContinuation } from './flow-progress.js';
import { parseFlow } from './flow-schema.js';
import { TaskInstructionStore } from './task-instructions.js';
import { TaskStore } from './tasks.js';
import { readUncertainStepAdjudication } from './uncertain-step-adjudication.js';
import { readContinuationLineage } from './continuation-lineage.js';
import { previewUncertainTaskStep } from './uncertain-step-preview.js';

const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  isDeepStrictEqual(Object.keys(value).sort(), keys.sort());

export interface AdjudicatedContinuationExpectation {
  readonly decisionId: string;
  readonly previewDigestSha256: string;
  readonly leaseToken: string;
}

export interface AdjudicatedContinuationReadExpectation extends AdjudicatedContinuationExpectation {
  readonly preparationId: string;
  /** SHA-256 receipt from the original writer, retained independently of preparation.json. */
  readonly preparationDigestSha256: string;
  /** The timeout selected when the preparation was written; omitted for the writer default. */
  readonly timeoutMs?: number;
}

function snapshotExpectation(expected: AdjudicatedContinuationExpectation) {
  const intent = { decisionId: expected.decisionId, previewDigestSha256: expected.previewDigestSha256,
    leaseToken: expected.leaseToken };
  if (!uuid(intent.decisionId) || !hex(intent.previewDigestSha256) || !uuid(intent.leaseToken))
    throw new Error('Invalid adjudicated continuation expectation');
  return intent;
}

function validTimeout(timeoutMs: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)
    throw new Error('Invalid adjudicated continuation checkpoint timeout');
  return timeoutMs;
}

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function inspect(store: TaskStore, successorTaskId: string,
  intent: ReturnType<typeof snapshotExpectation>, lockDirectory: string | undefined, timeoutMs: number,
  readOnly = false, transferRetryToken?: string) {
    const decision = await readUncertainStepAdjudication(store, successorTaskId);
    const decisionLease = decision.lease as { deviceId: string; token: string; runDirectory: string; snapshot: DeviceLease };
    if (decision.verdict !== 'postcondition-verified-skip' || decision.id !== intent.decisionId ||
      decision.previewDigestSha256 !== intent.previewDigestSha256 || decisionLease.token !== intent.leaseToken)
      throw new Error('Adjudication decision does not match requested skip');
    const preview = await previewUncertainTaskStep(store, successorTaskId);
    if (preview.previewDigestSha256 !== decision.previewDigestSha256 ||
      preview.sourceTaskId !== decision.sourceTaskId || preview.successorTaskId !== decision.successorTaskId ||
      preview.sourceRun !== decision.sourceRun || preview.runDirectory !== decision.runDirectory ||
      preview.activeStepIndex !== decision.activeStepIndex || preview.revision !== decision.revision ||
      !isDeepStrictEqual(preview.activeIdentity, decision.activeIdentity) ||
      !isDeepStrictEqual(preview.activeStep, decision.activeStep))
      throw new Error('Adjudication differs from current source or successor preview');
    const source = await store.get(preview.sourceTaskId);
    const successor = await store.get(successorTaskId);
    if (source.status !== 'interrupted' || successor.status !== 'interrupted' ||
      await store.cancellationRequested(source.id) || await store.cancellationRequested(successor.id) ||
      source.deviceId !== successor.deviceId || source.deviceId !== decisionLease.deviceId)
      throw new Error('Adjudication task state changed');
    const transferRetry = transferRetryToken === undefined ? undefined
      : await inspectUnstartedDeviceTransfer(decisionLease.snapshot, transferRetryToken, lockDirectory);
    const lease = transferRetry ? { lease: decisionLease.snapshot, owner: 'dead' as const }
      : await inspectDeviceLock(successor.deviceId, lockDirectory);
    if (!lease || lease.owner !== 'dead' || !isDeepStrictEqual(lease.lease, decisionLease.snapshot) ||
      lease.lease.token !== intent.leaseToken || !lease.lease.runDirectory ||
      await realpath(lease.lease.runDirectory) !== preview.runDirectory)
      throw new Error('Adjudication requires the exact abandoned successor device lease');
    const original: unknown = (await readContinuationLineage(store, successorTaskId)).claim;
    if (!original || typeof original !== 'object' || Array.isArray(original)) throw new Error('Invalid source continuation claim');
    const claim = original as Record<string, any>;
    if (!exactKeys(claim, ['version', 'id', 'sourceTaskId', 'deviceId', 'owner', 'createdAt', 'flow',
      'source', 'omittedResets', 'stepOrigins', 'resumeAuthorized']) ||
      claim.version !== 1 || !uuid(claim.id) || claim.id !== decision.claimId ||
      claim.sourceTaskId !== source.id || claim.deviceId !== successor.deviceId ||
      claim.resumeAuthorized !== false || !claim.owner || !Number.isSafeInteger(claim.owner.pid) ||
      typeof claim.owner.host !== 'string' || typeof claim.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(claim.createdAt)) || !Number.isSafeInteger(claim.source?.completedSteps) ||
      claim.source.completedSteps < 0) throw new Error('Malformed source continuation claim');
    const instructionStore = new TaskInstructionStore(store);
    const instructions = readOnly ? await instructionStore.listReadOnly(successorTaskId)
      : await instructionStore.list(successorTaskId);
    const prepared = await prepareAdjudicatedFlowContinuation(preview.runDirectory,
      decision.postconditionCheckpoint, instructions, timeoutMs);
    if (prepared.source.revision !== preview.revision ||
      prepared.source.skippedStepIndex !== preview.activeStepIndex ||
      prepared.source.completedSteps !== preview.completedSteps ||
      !isDeepStrictEqual(prepared.source.completedEvidenceSha256, preview.completedEvidenceSha256))
      throw new Error('Adjudicated continuation progress differs from preview');
    const predecessorOrigins = prepared.stepOrigins.map(origin =>
      'flowIndex' in origin && typeof origin.flowIndex === 'number' && origin.flowIndex > 0
        ? claim.stepOrigins[origin.flowIndex - 1] : null);
    if (predecessorOrigins.some((origin, index) => {
      const step = prepared.stepOrigins[index];
      return !!step && 'flowIndex' in step && typeof step.flowIndex === 'number' && step.flowIndex > 0 &&
        (!origin || origin.continuationIndex !== step.flowIndex);
    }))
      throw new Error('Source continuation origin changed');
    return { decision, preview, lease, prepared, predecessorOrigins, transferRetry,
      originalSourceCompletedSteps: claim.source.completedSteps as number };
}

/**
 * Persists one non-runnable proposal. A future runner must transfer the exact abandoned
 * lease without unlocking it, observe the postcondition on the live device, and recheck.
 */
export async function prepareAdjudicatedTaskContinuation(store: TaskStore, successorTaskId: string,
  expected: AdjudicatedContinuationExpectation, lockDirectory?: string, timeoutMs = 10000) {
  const intent = snapshotExpectation(expected);
  validTimeout(timeoutMs);

  const before = await inspect(store, successorTaskId, intent, lockDirectory, timeoutMs);
  const directory = join(store.directory, successorTaskId, 'adjudicated-continuation');
  // Keep an empty reservation after any failure: no second proposal can silently replace it.
  await mkdir(directory);
  const immediatelyBefore = await inspect(store, successorTaskId, intent, lockDirectory, timeoutMs);
  if (!isDeepStrictEqual(before, immediatelyBefore)) throw new Error('Adjudicated continuation changed while reserving');
  const claim = expectedClaim(before, randomUUID(), new Date().toISOString(),
    { pid: process.pid, host: hostname() }, successorTaskId);
  const bytes = JSON.stringify(claim, null, 2);
  const handle = await open(join(directory, 'preparation.json'), 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  const after = await inspect(store, successorTaskId, intent, lockDirectory, timeoutMs);
  if (!isDeepStrictEqual(before, after)) throw new Error('Adjudicated continuation changed after write; non-runnable preparation retained');
  return { directory, claim, preparationDigestSha256: digest(bytes) };
}

function expectedClaim(inspected: Awaited<ReturnType<typeof inspect>>, id: string, createdAt: string,
  owner: { pid: number; host: string }, successorTaskId: string) {
  const before = inspected;
  return { version: 1 as const, kind: 'adjudicated-continuation-preparation' as const,
    id, createdAt, owner, sourceTaskId: before.preview.sourceTaskId,
    predecessorTaskId: successorTaskId, predecessorClaimId: before.decision.claimId,
    decisionId: before.decision.id, previewDigestSha256: before.preview.previewDigestSha256,
    abandonedLease: { deviceId: before.lease.lease.deviceId, token: before.lease.lease.token,
      runDirectory: before.preview.runDirectory, snapshot: before.lease.lease },
    skipped: { stepIndex: before.preview.activeStepIndex, identity: before.preview.activeIdentity,
      step: before.preview.activeStep, sourceOrigin: before.preview.sourceOrigin ?? null },
    inheritedPassedPrefix: { completedSteps: before.prepared.source.completedSteps,
      evidenceSha256: before.prepared.source.completedEvidenceSha256,
      originalSourceCompletedSteps: before.originalSourceCompletedSteps },
    predecessorStepOrigins: before.predecessorOrigins,
    flow: before.prepared.flow, source: before.prepared.source,
    omittedResets: before.prepared.omittedResets, stepOrigins: before.prepared.stepOrigins,
    state: 'awaiting-guarded-live-checkpoint' as const, resumeAuthorized: false as const };
}

/**
 * Reads and revalidates a persisted non-runnable preparation without reserving or writing.
 * The caller must retain the writer's preparation ID, digest, and timeout independently; for a
 * custom writer timeout, pass that value here instead of relying on the 10000 ms default.
 * This reader does not grant permission to transfer a lease or execute the Flow.
 */
export async function readAdjudicatedTaskContinuation(store: TaskStore, successorTaskId: string,
  expected: AdjudicatedContinuationReadExpectation, lockDirectory?: string, transferRetryToken?: string) {
  // Snapshot all caller input before the first await so mutations cannot change the read's intent.
  const intent = snapshotExpectation(expected);
  const preparationId = expected.preparationId;
  const preparationDigestSha256 = expected.preparationDigestSha256;
  const timeoutMs = validTimeout(expected.timeoutMs === undefined ? 10000 : expected.timeoutMs);
  if (!uuid(preparationId) || !hex(preparationDigestSha256))
    throw new Error('Invalid adjudicated continuation preparation receipt');

  const before = await inspect(store, successorTaskId, intent, lockDirectory, timeoutMs, true, transferRetryToken);
  const directory = join(store.directory, successorTaskId, 'adjudicated-continuation');
  const path = join(directory, 'preparation.json');
  const raw = await readFile(path);
  const value: unknown = JSON.parse(raw.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed adjudicated continuation preparation');
  const claim = value as Record<string, unknown>;
  const owner = claim.owner;
  if (!uuid(claim.id) || claim.id !== preparationId || typeof claim.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(claim.createdAt)) ||
    new Date(claim.createdAt).toISOString() !== claim.createdAt ||
    !owner || typeof owner !== 'object' || Array.isArray(owner) ||
    !exactKeys(owner as Record<string, unknown>, ['pid', 'host']) ||
    !Number.isSafeInteger((owner as Record<string, unknown>).pid) ||
    ((owner as Record<string, unknown>).pid as number) < 1 ||
    typeof (owner as Record<string, unknown>).host !== 'string' ||
    !(owner as Record<string, unknown>).host)
    throw new Error('Malformed adjudicated continuation preparation');
  // parseFlow applies its existing bounds, including the wait checkpoint timeout.
  parseFlow(claim.flow);
  if (digest(raw) !== preparationDigestSha256)
    throw new Error('Adjudicated continuation preparation digest mismatch');
  const reconstructed = expectedClaim(before, preparationId, claim.createdAt,
    owner as { pid: number; host: string }, successorTaskId);
  if (!isDeepStrictEqual(claim, reconstructed))
    throw new Error('Adjudicated continuation preparation differs from current inputs');
  const after = await inspect(store, successorTaskId, intent, lockDirectory, timeoutMs, true, transferRetryToken);
  if (!isDeepStrictEqual(before, after) || !(await readFile(path)).equals(raw))
    throw new Error('Adjudicated continuation changed during read');
  return { directory, claim: claim as typeof reconstructed, transferRetry: before.transferRetry };
}
