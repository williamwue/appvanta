import { access, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

// Caller holds the device recovery guard while archiving and claiming again.
export async function archiveCancelledContinuation(directory: string, taskId: string, deviceId: string, leaseToken: string) {
  let text: string;
  try { text = await readFile(join(directory, 'cancelled-before-transfer.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const cancelled = JSON.parse(text);
  const claim = JSON.parse(await readFile(join(directory, 'claim.json'), 'utf8'));
  if (cancelled.version !== 1 || cancelled.claimId !== claim.id || cancelled.taskId !== taskId
    || cancelled.leaseToken !== leaseToken || cancelled.phase !== 'cleanup-complete-before-transfer'
    || claim.sourceTaskId !== taskId || claim.deviceId !== deviceId || claim.owner?.host !== hostname()
    || !Number.isSafeInteger(claim.owner.pid) || claim.owner.pid < 1) throw new Error('Cancelled continuation claim does not match source lease');
  try { process.kill(claim.owner.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Cannot verify cancelled continuation owner exit');
    try { await access(join(directory, 'successor.json')); }
    catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
      const archived = `${directory}.cancelled-${randomUUID()}`;
      await rename(directory, archived);
      return archived;
    }
    throw new Error('Cancelled continuation already has a successor');
  }
  throw new Error('Cancelled continuation owner is still alive');
}
