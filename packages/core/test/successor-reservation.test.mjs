import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, parseFlow, readAdjudicatedSuccessorReservation, reconcileAdjudicatedSuccessor } from '../dist/index.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const flow = parseFlow({ name: 'reserved successor', steps: [
  { description: 'verify live postcondition', action: { kind: 'wait', condition: { kind: 'text-visible', text: 'Done' }, timeoutMs: 1000 } },
  { description: 'later action', action: { kind: 'back' } },
] });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-successor-reservation-'));
  const store = new TaskStore(join(root, 'tasks'));
  const predecessorTaskId = 'task-11111111-1111-4111-8111-111111111111';
  const sourceTaskId = 'task-22222222-2222-4222-8222-222222222222';
  const preparationId = '33333333-3333-4333-8333-333333333333';
  const decisionId = '44444444-4444-4444-8444-444444444444';
  const leaseToken = '55555555-5555-4555-8555-555555555555';
  const preparation = {
    version: 1, kind: 'adjudicated-continuation-preparation', id: preparationId,
    createdAt: new Date().toISOString(), owner: { pid: 1, host: 'host', session: '66666666-6666-4666-8666-666666666666' },
    sourceTaskId, predecessorTaskId, predecessorClaimId: randomUUID(), decisionId,
    previewDigestSha256: 'a'.repeat(64), abandonedLease: { deviceId: 'device', token: leaseToken },
    flow, source: { revision: 2 }, omittedResets: [], stepOrigins: [], state: 'awaiting-guarded-live-checkpoint', resumeAuthorized: false,
  };
  const prepDir = join(store.directory, predecessorTaskId, 'adjudicated-continuation');
  await mkdir(prepDir, { recursive: true });
  const prepBytes = JSON.stringify(preparation, null, 2);
  await writeFile(join(prepDir, 'preparation.json'), prepBytes);
  const receipt = { preparationId, preparationDigestSha256: sha(prepBytes), decisionId,
    previewDigestSha256: preparation.previewDigestSha256, leaseToken };
  const reservation = {
    version: 1, kind: 'adjudicated-successor-reservation', id: '77777777-7777-4777-8777-777777777777',
    createdAt: new Date().toISOString(), owner: { pid: 1, host: 'host', session: '66666666-6666-4666-8666-666666666666' },
    predecessorTaskId, sourceTaskId, preparationId, preparationDigestSha256: receipt.preparationDigestSha256,
    decisionId, previewDigestSha256: receipt.previewDigestSha256, leaseToken,
    successorTaskId: 'task-88888888-8888-4888-8888-888888888888', deviceId: 'device', flow,
    flowSha256: sha(JSON.stringify(flow)), state: 'reserved', resumeAuthorized: false,
  };
  await writeFile(join(prepDir, 'successor-reservation.json'), JSON.stringify(reservation, null, 2));
  return { root, store, predecessorTaskId, receipt, reservation, prepDir };
}

test('reconciles one immutable reservation after process death and is idempotent', async () => {
  const f = await fixture();
  try {
    const read = await readAdjudicatedSuccessorReservation(f.store, f.predecessorTaskId, f.receipt);
    assert.equal(read.reservation.successorTaskId, f.reservation.successorTaskId);
    const results = await Promise.all([1, 2, 3].map(() => reconcileAdjudicatedSuccessor(f.store, f.predecessorTaskId, f.receipt)));
    assert(results.every(result => result.task.id === f.reservation.successorTaskId));
    assert.deepEqual(JSON.parse(await readFile(join(f.store.directory, f.reservation.successorTaskId, 'task.json'))).flow, flow);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('reservation reconciliation rejects tampered preparation or reservation identity', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.prepDir, 'successor-reservation.json'), JSON.stringify({ ...f.reservation, flowSha256: 'b'.repeat(64) }));
    await assert.rejects(readAdjudicatedSuccessorReservation(f.store, f.predecessorTaskId, f.receipt), /Flow digest/);
    await writeFile(join(f.prepDir, 'successor-reservation.json'), JSON.stringify(f.reservation));
    await writeFile(join(f.prepDir, 'preparation.json'), JSON.stringify({ ...JSON.parse(await readFile(join(f.prepDir, 'preparation.json'))), flow: { ...flow, name: 'changed' } }));
    await assert.rejects(reconcileAdjudicatedSuccessor(f.store, f.predecessorTaskId, f.receipt), /digest mismatch|binding changed/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
