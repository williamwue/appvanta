import { readAdjudicatedExecution, type SuccessorReservationReceipt, type TaskStore } from '@appvanta/core';
import { continueAndroidTask } from './continue-task.js';

/** Restart only at a verified step boundary, using a new checkpoint and current lease token. */
export async function restartAdjudicatedAndroidTask(store: TaskStore, predecessorTaskId: string,
  successorTaskId: string, receiptInput: SuccessorReservationReceipt, leaseToken: string,
  checkpoint: unknown, signal?: AbortSignal) {
  const receipt = { ...receiptInput };
  const expected = await readAdjudicatedExecution(store, predecessorTaskId, successorTaskId, receipt);
  const validate = async () => {
    const current = await readAdjudicatedExecution(store, predecessorTaskId, successorTaskId, receipt);
    if (current.lineageDigestSha256 !== expected.lineageDigestSha256 ||
      current.reservationDigestSha256 !== expected.reservationDigestSha256 || current.runDirectory !== expected.runDirectory)
      throw new Error('Adjudicated execution changed before restart');
  };
  return continueAndroidTask(store, successorTaskId, leaseToken, checkpoint, signal, undefined, validate);
}
