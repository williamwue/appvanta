import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readAdjudicatedTaskContinuation, type AdjudicatedContinuationReadExpectation } from './adjudicated-continuation.js';
import { parseFlow } from './flow-schema.js';
import { TaskStore, type TaskRecord } from './tasks.js';

const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const taskId = (value: unknown): value is string => typeof value === 'string' &&
  /^task-[a-f0-9-]{36}$/.test(value);
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const isCode = (error: unknown, code: string) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  isDeepStrictEqual(Object.keys(value).sort(), keys.slice().sort());

export interface SuccessorReservationReceipt {
  readonly preparationId: string;
  readonly preparationDigestSha256: string;
  readonly decisionId: string;
  readonly previewDigestSha256: string;
  readonly leaseToken: string;
  readonly timeoutMs?: number;
}

export interface SuccessorReservation {
  readonly version: 1;
  readonly kind: 'adjudicated-successor-reservation';
  readonly id: string;
  readonly createdAt: string;
  readonly owner: { readonly pid: number; readonly host: string; readonly session: string };
  readonly predecessorTaskId: string;
  readonly sourceTaskId: string;
  readonly preparationId: string;
  readonly preparationDigestSha256: string;
  readonly decisionId: string;
  readonly previewDigestSha256: string;
  readonly leaseToken: string;
  readonly successorTaskId: string;
  readonly deviceId: string;
  readonly flow: ReturnType<typeof parseFlow>;
  readonly flowSha256: string;
  readonly state: 'reserved';
  readonly resumeAuthorized: false;
}

function validateReceipt(receipt: SuccessorReservationReceipt) {
  if (!receipt || !uuid(receipt.preparationId) || !hex(receipt.preparationDigestSha256) ||
    !uuid(receipt.decisionId) || !hex(receipt.previewDigestSha256) || !uuid(receipt.leaseToken) ||
    receipt.timeoutMs !== undefined && (!Number.isSafeInteger(receipt.timeoutMs) || receipt.timeoutMs < 1 || receipt.timeoutMs > 3600000))
    throw new Error('Invalid successor reservation preparation receipt');
  return { ...receipt };
}

function reservationPath(store: TaskStore, predecessorTaskId: string) {
  if (!taskId(predecessorTaskId)) throw new Error('Invalid predecessor task id');
  return join(store.directory, predecessorTaskId, 'adjudicated-continuation', 'successor-reservation.json');
}

async function readPreparationFile(store: TaskStore, predecessorTaskId: string, receipt: SuccessorReservationReceipt) {
  const path = join(store.directory, predecessorTaskId, 'adjudicated-continuation', 'preparation.json');
  const raw = await readFile(path);
  if (digest(raw) !== receipt.preparationDigestSha256) throw new Error('Preparation digest mismatch');
  const claim: any = JSON.parse(raw.toString('utf8'));
  if (!claim || claim.version !== 1 || claim.kind !== 'adjudicated-continuation-preparation' ||
    !uuid(claim.id) || claim.id !== receipt.preparationId || claim.predecessorTaskId !== predecessorTaskId ||
    !uuid(claim.decisionId) || claim.decisionId !== receipt.decisionId ||
    !hex(claim.previewDigestSha256) || claim.previewDigestSha256 !== receipt.previewDigestSha256 ||
    !claim.abandonedLease || !uuid(claim.abandonedLease.token) || claim.abandonedLease.token !== receipt.leaseToken ||
    claim.resumeAuthorized !== false || claim.state !== 'awaiting-guarded-live-checkpoint' ||
    typeof claim.sourceTaskId !== 'string' || !taskId(claim.sourceTaskId) || !claim.flow || !claim.source)
    throw new Error('Malformed adjudicated preparation for successor reservation');
  const flow = parseFlow(claim.flow);
  return { raw, claim, flow };
}

async function readReservation(store: TaskStore, predecessorTaskId: string, receipt: SuccessorReservationReceipt) {
  const path = reservationPath(store, predecessorTaskId);
  const raw = await readFile(path);
  const value: any = JSON.parse(raw.toString('utf8'));
  if (!value || value.version !== 1 || value.kind !== 'adjudicated-successor-reservation' ||
    !exactKeys(value, ['version', 'kind', 'id', 'createdAt', 'owner', 'predecessorTaskId', 'sourceTaskId',
      'preparationId', 'preparationDigestSha256', 'decisionId', 'previewDigestSha256', 'leaseToken',
      'successorTaskId', 'deviceId', 'flow', 'flowSha256', 'state', 'resumeAuthorized']) ||
    !uuid(value.id) || !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    !value.owner || !exactKeys(value.owner, ['pid', 'host', 'session']) || !Number.isSafeInteger(value.owner.pid) || value.owner.pid < 1 ||
    typeof value.owner.host !== 'string' || !uuid(value.owner.session) ||
    value.predecessorTaskId !== predecessorTaskId || !taskId(value.sourceTaskId) ||
    !uuid(value.preparationId) || !hex(value.preparationDigestSha256) || !uuid(value.decisionId) ||
    !hex(value.previewDigestSha256) || !uuid(value.leaseToken) || !taskId(value.successorTaskId) ||
    typeof value.deviceId !== 'string' || !value.deviceId || value.state !== 'reserved' || value.resumeAuthorized !== false)
    throw new Error('Malformed successor reservation');
  const parsedFlow = parseFlow(value.flow);
  if (!hex(value.flowSha256) || value.flowSha256 !== digest(JSON.stringify(parsedFlow)))
    throw new Error('Successor reservation Flow digest mismatch');
  if (value.preparationId !== receipt.preparationId || value.preparationDigestSha256 !== receipt.preparationDigestSha256 ||
    value.decisionId !== receipt.decisionId || value.previewDigestSha256 !== receipt.previewDigestSha256 || value.leaseToken !== receipt.leaseToken)
    throw new Error('Successor reservation does not match preparation receipt');
  return { path, raw, reservation: value as SuccessorReservation };
}

/** Reserve one predetermined successor ID, then publish its queued task exactly once. */
export async function reserveAdjudicatedSuccessor(store: TaskStore, predecessorTaskId: string,
  receiptInput: SuccessorReservationReceipt, lockDirectory?: string): Promise<{ reservation: SuccessorReservation; task: TaskRecord }> {
  const receipt = validateReceipt(receiptInput);
  // The strict reader is used only before reservation creation. Later reconciliation is offline.
  const preparation = await readAdjudicatedTaskContinuation(store, predecessorTaskId, receipt, lockDirectory);
  const path = reservationPath(store, predecessorTaskId);
  await mkdir(join(store.directory, predecessorTaskId, 'adjudicated-continuation'), { recursive: true });
  let reservation: SuccessorReservation;
  try {
    const existing = await readReservation(store, predecessorTaskId, receipt);
    reservation = existing.reservation;
  } catch (error) {
    if (!isCode(error, 'ENOENT')) throw error;
    const successorTaskId = `task-${randomUUID()}`;
    const value: SuccessorReservation = {
      version: 1, kind: 'adjudicated-successor-reservation', id: randomUUID(), createdAt: new Date().toISOString(),
      owner: { pid: process.pid, host: hostname(), session: store.workerSession }, predecessorTaskId,
      sourceTaskId: preparation.claim.sourceTaskId, preparationId: receipt.preparationId,
      preparationDigestSha256: receipt.preparationDigestSha256, decisionId: receipt.decisionId,
      previewDigestSha256: receipt.previewDigestSha256, leaseToken: receipt.leaseToken,
      successorTaskId, deviceId: preparation.claim.abandonedLease.deviceId, flow: preparation.claim.flow,
      flowSha256: digest(JSON.stringify(preparation.claim.flow)), state: 'reserved', resumeAuthorized: false,
    };
    try {
      const handle = await open(path, 'wx');
      try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
      finally { await handle.close(); }
      reservation = value;
    } catch (writeError) {
      if (!isCode(writeError, 'EEXIST')) throw writeError;
      reservation = (await readReservation(store, predecessorTaskId, receipt)).reservation;
    }
  }
  const task = await store.createReserved(reservation.successorTaskId, reservation.deviceId, reservation.flow,
    { id: reservation.id, digestSha256: digest(JSON.stringify(reservation)) });
  return { reservation, task };
}

/** Reconcile a persisted reservation after process death without reading device/lease state. */
export async function reconcileAdjudicatedSuccessor(store: TaskStore, predecessorTaskId: string,
  receiptInput: SuccessorReservationReceipt): Promise<{ reservation: SuccessorReservation; task: TaskRecord }> {
  const receipt = validateReceipt(receiptInput);
  const { reservation } = await readReservation(store, predecessorTaskId, receipt);
  const preparation = await readPreparationFile(store, predecessorTaskId, receipt);
  if (preparation.claim.sourceTaskId !== reservation.sourceTaskId || preparation.claim.abandonedLease.deviceId !== reservation.deviceId ||
    !isDeepStrictEqual(preparation.flow, reservation.flow) || reservation.flowSha256 !== digest(JSON.stringify(reservation.flow)))
    throw new Error('Successor reservation preparation binding changed');
  const task = await store.createReserved(reservation.successorTaskId, reservation.deviceId, reservation.flow,
    { id: reservation.id, digestSha256: digest(JSON.stringify(reservation)) }, { allowRunningRecovery: true });
  return { reservation, task };
}

export async function readAdjudicatedSuccessorReservation(store: TaskStore, predecessorTaskId: string,
  receiptInput: SuccessorReservationReceipt) {
  const receipt = validateReceipt(receiptInput);
  const { reservation } = await readReservation(store, predecessorTaskId, receipt);
  const preparation = await readPreparationFile(store, predecessorTaskId, receipt);
  if (preparation.claim.sourceTaskId !== reservation.sourceTaskId || !isDeepStrictEqual(preparation.flow, reservation.flow) ||
    reservation.flowSha256 !== digest(JSON.stringify(reservation.flow))) throw new Error('Successor reservation preparation binding changed');
  return { reservation };
}
