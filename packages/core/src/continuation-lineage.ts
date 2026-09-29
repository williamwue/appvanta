import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { TaskStore, type TaskRecord } from './tasks.js';
import { readAdjudicatedExecution } from './adjudicated-execution.js';

/** Resolve historical lineage for a preview; this never authorizes a lease transfer. */
export async function readContinuationLineage(store: TaskStore, successorTaskId: string, inspectedTask?: TaskRecord) {
  const task = inspectedTask ?? await store.get(successorTaskId);
  if (task.id !== successorTaskId) throw new Error('Continuation task identity mismatch');
  if (!task.runDirectory) throw new Error('Successor has no bound run directory');
  const root = await realpath(task.runDirectory);
  const ordinaryPath = join(root, 'continuation.json');
  const adjudicatedPath = join(root, 'adjudicated-continuation.json');
  const optional = async (path: string) => {
    try { return await readFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const ordinary = await optional(ordinaryPath), adjudicated = await optional(adjudicatedPath);
  if (!!ordinary === !!adjudicated) throw new Error('Missing or ambiguous successor continuation link');
  const marker = JSON.parse((ordinary ?? adjudicated)!.toString('utf8'));
  const sourceTaskId = ordinary ? marker.sourceTaskId : marker.predecessorTaskId;
  if (typeof sourceTaskId !== 'string' || !/^task-[a-f0-9-]{36}$/.test(sourceTaskId) || sourceTaskId === successorTaskId)
    throw new Error('Invalid continuation source task identity');
  if (ordinary) {
    const claimPath = join(store.directory, sourceTaskId, 'continuation', 'claim.json');
    const successorPath = join(store.directory, sourceTaskId, 'continuation', 'successor.json');
    const readJson = async (path: string, label: string) => {
      try { return JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { throw new Error(`Missing or invalid ${label}`, { cause: error }); }
    };
    const claim = await readJson(claimPath, 'source continuation claim');
    const link = await readJson(successorPath, 'source successor link');
    if (!isDeepStrictEqual(marker, claim) || !isDeepStrictEqual(link, { taskId: successorTaskId })) throw new Error('Successor claim/link mismatch');
    return { kind: 'ordinary' as const, sourceTaskId, claim, claimPath, successorPath, markerPath: ordinaryPath };
  }
  await readAdjudicatedExecution(store, sourceTaskId, successorTaskId, marker.preparationReceipt);
  const claimPath = join(store.directory, sourceTaskId, 'adjudicated-continuation', 'preparation.json');
  const successorPath = join(store.directory, sourceTaskId, 'adjudicated-continuation', 'successor-reservation.json');
  const bytes = await readFile(claimPath);
  if (createHash('sha256').update(bytes).digest('hex') !== marker.preparationReceipt.preparationDigestSha256)
    throw new Error('Adjudicated lineage preparation changed');
  const preparation = JSON.parse(bytes.toString('utf8'));
  const claim = { version: 1, id: preparation.id, sourceTaskId, deviceId: task.deviceId,
    owner: preparation.owner, createdAt: preparation.createdAt, flow: preparation.flow,
    source: preparation.source, omittedResets: preparation.omittedResets,
    stepOrigins: preparation.stepOrigins, resumeAuthorized: false };
  return { kind: 'adjudicated' as const, sourceTaskId, claim, claimPath, successorPath, markerPath: adjudicatedPath };
}
