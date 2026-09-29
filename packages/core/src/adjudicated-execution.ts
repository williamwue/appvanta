import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TaskStore } from './tasks.js';
import { readAdjudicatedSuccessorReservation, type SuccessorReservationReceipt } from './successor-reservation.js';

/** Historical execution identity only; callers must retain the preparation receipt independently. */
export async function readAdjudicatedExecution(store: TaskStore, predecessorTaskId: string,
  successorTaskId: string, receiptInput: SuccessorReservationReceipt) {
  const receipt = { ...receiptInput };
  const { reservation } = await readAdjudicatedSuccessorReservation(store, predecessorTaskId, receipt);
  if (reservation.successorTaskId !== successorTaskId) throw new Error('Adjudicated execution successor mismatch');
  const task = await store.get(successorTaskId);
  if (!task.runDirectory || task.deviceId !== reservation.deviceId || !isDeepStrictEqual(task.flow, reservation.flow))
    throw new Error('Adjudicated execution task binding mismatch');
  const root = await realpath(task.runDirectory);
  const path = join(root, 'adjudicated-continuation.json');
  const raw = await readFile(path);
  const marker = JSON.parse(raw.toString('utf8'));
  const source = await store.get(predecessorTaskId);
  if (!source.runDirectory || source.deviceId !== task.deviceId) throw new Error('Adjudicated predecessor binding mismatch');
  const sourceRun = await realpath(source.runDirectory);
  const digest = createHash('sha256').update(JSON.stringify(reservation)).digest('hex');
  const expected = { version: 1, kind: 'adjudicated-android-continuation', predecessorTaskId,
    sourceTaskId: reservation.sourceTaskId, successorTaskId, reservationId: reservation.id,
    preparationId: reservation.preparationId, decisionId: reservation.decisionId,
    preparationReceipt: receipt, reservationDigestSha256: digest, leaseToken: reservation.leaseToken,
    sourceRun, runDirectory: root, guardedCheckpoint: reservation.flow.steps[0]?.action,
    omittedResets: marker?.omittedResets, resumeAuthorized: false };
  const preparation = JSON.parse(await readFile(join(store.directory, predecessorTaskId, 'adjudicated-continuation', 'preparation.json'), 'utf8'));
  if (!isDeepStrictEqual(marker, expected) || !isDeepStrictEqual(marker.omittedResets, preparation.omittedResets))
    throw new Error('Adjudicated execution lineage mismatch');
  const flowPath = join(root, 'flow.json');
  const flowBytes = await readFile(flowPath);
  const runFlow = JSON.parse(flowBytes.toString('utf8'));
  if (!isDeepStrictEqual(runFlow, reservation.flow)) throw new Error('Adjudicated execution Flow mismatch');
  const after = await readAdjudicatedSuccessorReservation(store, predecessorTaskId, receipt);
  if (!isDeepStrictEqual(after.reservation, reservation) || !(await readFile(path)).equals(raw) || !(await readFile(flowPath)).equals(flowBytes) ||
    !isDeepStrictEqual(await store.get(successorTaskId), task) || !isDeepStrictEqual(await store.get(predecessorTaskId), source))
    throw new Error('Adjudicated execution changed during read');
  return { predecessorTaskId, successorTaskId, sourceTaskId: reservation.sourceTaskId,
    runDirectory: root, sourceRun, reservationDigestSha256: digest,
    lineageDigestSha256: createHash('sha256').update(raw).digest('hex'), resumeAuthorized: false as const };
}
