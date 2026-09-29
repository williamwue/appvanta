import { realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  inspectDeviceLock,
  readAdjudicatedTaskContinuation,
  readAdjudicatedSuccessorReservation,
  reconcileAdjudicatedSuccessor,
  TaskStore,
  type SuccessorReservationReceipt,
} from '@appvanta/core';
import { continueAndroidFlow } from './recover-flow.js';
import { runAndroidFlow } from './flow.js';

type ContinueFlow = typeof continueAndroidFlow;
type RunFlow = typeof runAndroidFlow;

export interface AdjudicatedAndroidContinuationOptions {
  readonly lockDirectory?: string;
  readonly signal?: AbortSignal;
  /** Deterministic seams for the offline/fake tests; production uses Android recovery. */
  readonly continueFlow?: ContinueFlow;
  readonly runFlow?: RunFlow;
}

export const validateAdjudicatedAndroidFlow = (flow: any) => {
  const first = flow?.steps?.[0];
  if (first?.action?.kind !== 'wait' || first.action.condition === undefined ||
    flow.resetApplications?.length) throw new Error('Adjudicated continuation must begin with a guarded wait and no reset');
};

/**
 * Continue exactly one adjudicated successor. The old lease is checked while it
 * is still dead, then continueAndroidFlow transfers it without unlocking it.
 * The prepared Flow always starts with the fresh guarded live wait; no reset
 * action from the predecessor is carried into this execution.
 */
export async function continueAdjudicatedAndroidTask(store: TaskStore, predecessorTaskId: string,
  receipt: SuccessorReservationReceipt, options: AdjudicatedAndroidContinuationOptions = {}) {
  const continueFlow = options.continueFlow ?? continueAndroidFlow;
  const runFlow = options.runFlow ?? runAndroidFlow;
  const prepared = await readAdjudicatedTaskContinuation(store, predecessorTaskId, receipt, options.lockDirectory);
  const reserved = await readAdjudicatedSuccessorReservation(store, predecessorTaskId, receipt);
  const claim = prepared.claim;
  const reservation = reserved.reservation;
  if (reservation.sourceTaskId !== claim.sourceTaskId || reservation.deviceId !== claim.abandonedLease.deviceId ||
    reservation.leaseToken !== claim.abandonedLease.token || reservation.preparationId !== claim.id ||
    !isDeepStrictEqual(reservation.flow, claim.flow))
    throw new Error('Adjudicated successor reservation does not match guarded preparation');
  validateAdjudicatedAndroidFlow(claim.flow);
  if (!claim.abandonedLease.runDirectory) throw new Error('Adjudicated continuation has no abandoned run');

  // Reconciliation is idempotent and does not inspect the device. It creates a
  // queued reservation task when a prior process died before publication.
  const reconciled = await reconcileAdjudicatedSuccessor(store, predecessorTaskId, receipt);
  if (reconciled.task.id !== reservation.successorTaskId ||
    reconciled.task.status !== 'queued' && reconciled.task.status !== 'running')
    throw new Error('Adjudicated successor is not queued or recoverable after a guarded claim');
  const markerDigest = createHash('sha256').update(JSON.stringify(reservation)).digest('hex');
  let task = reconciled.task;

  const revalidateDeadLease = async () => {
    const latest = await readAdjudicatedTaskContinuation(store, predecessorTaskId, receipt, options.lockDirectory);
    const latestReservation = await readAdjudicatedSuccessorReservation(store, predecessorTaskId, receipt);
    if (!isDeepStrictEqual(latest.claim, claim) || !isDeepStrictEqual(latestReservation.reservation, reservation))
      throw new Error('Adjudicated preparation changed before lease transfer');
    const state = await inspectDeviceLock(claim.abandonedLease.deviceId, options.lockDirectory);
    if (!state || state.owner !== 'dead' || !isDeepStrictEqual(state.lease, claim.abandonedLease.snapshot) ||
      state.lease.token !== claim.abandonedLease.token || state.lease.deviceId !== claim.abandonedLease.deviceId ||
      !state.lease.runDirectory || await realpath(state.lease.runDirectory) !== await realpath(claim.abandonedLease.runDirectory))
      throw new Error('Adjudicated continuation requires the exact dead lease');
  };

  return continueFlow(claim.abandonedLease.deviceId, claim.abandonedLease.token, async sourceRun => {
    const state = await inspectDeviceLock(claim.abandonedLease.deviceId, options.lockDirectory);
    if (!state || state.owner !== 'alive' || state.lease.recoveredFrom?.token !== claim.abandonedLease.token ||
      !state.lease.runDirectory || await realpath(state.lease.runDirectory) !== await realpath(sourceRun))
      throw new Error('Transferred lease does not retain adjudicated source lineage');
    task = task.status === 'running'
      ? await store.recoverReservedRunning(task.id, { id: reservation.id, digestSha256: markerDigest }, task.revision)
      : await store.claimReserved(task.id, { id: reservation.id, digestSha256: markerDigest }, task.revision);
    try {
      const result = await runFlow(task.deviceId, claim.flow, options.signal, async root => {
        const lineage = {
          version: 1, kind: 'adjudicated-android-continuation',
          predecessorTaskId, sourceTaskId: claim.sourceTaskId, successorTaskId: task.id,
          reservationId: reservation.id, preparationId: claim.id, decisionId: claim.decisionId,
          leaseToken: claim.abandonedLease.token, sourceRun: await realpath(sourceRun),
          runDirectory: await realpath(root), guardedCheckpoint: claim.flow.steps[0]?.action,
          omittedResets: claim.omittedResets, resumeAuthorized: false,
        } as const;
        await writeFile(join(root, 'adjudicated-continuation.json'), JSON.stringify(lineage, null, 2), { flag: 'wx' });
        task.runDirectory = root;
        await store.save(task);
      });
      task.status = result.status;
      task.result = result;
      task.finishedAt = new Date().toISOString();
      await store.save(task);
      if (result.status !== 'passed') throw new Error(`Adjudicated continuation ${task.id} ${result.status}; lease retained for inspection`);
      return { taskId: task.id, predecessorTaskId, sourceTaskId: claim.sourceTaskId, ...result };
    } catch (error) {
      if (!task.finishedAt) {
        task.status = options.signal?.aborted ? 'cancelled' : 'failed';
        task.error = String(error);
        task.finishedAt = new Date().toISOString();
        await store.save(task);
      }
      throw error;
    }
  }, async () => {
    await revalidateDeadLease();
  }, options.signal);
}
