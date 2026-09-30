import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';

type BuildOutcome = {
  execution: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  cleanup: 'verified' | 'unverified';
};

async function directory(path: string): Promise<void> {
  try { await mkdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Build state must be a real directory: ${path}`);
}

async function writeReceipt(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
}

/** Internal executor primitive. Only its supervisor may attest execution and cleanup. */
export async function acquireBuildProject(projectDirectory: string) {
  const project = await realpath(projectDirectory);
  if (!(await lstat(project)).isDirectory()) throw new Error('Build project must be a directory');
  const state = join(project, '.appvanta', 'android-build');
  await directory(join(project, '.appvanta'));
  await directory(state);
  await directory(join(state, 'runs'));
  const active = join(state, 'active');
  try { await mkdir(active); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw Object.assign(new Error(`Build project is occupied; explicit recovery is required: ${project}`), { code: 'BUILD_PROJECT_BUSY' });
  }
  const owner = Object.freeze({ version: 1 as const, runId: randomUUID(), projectDirectory: project, ownerPid: process.pid, createdAt: new Date().toISOString() });
  const encoded = JSON.stringify(owner, null, 2);
  await writeReceipt(join(active, 'owner.json'), owner);
  let finalized = false;
  return Object.freeze({
    owner,
    recordDirectory: active,
    async finish(outcome: BuildOutcome): Promise<{ released: boolean; recordDirectory: string }> {
      if (finalized) throw new Error('Build ownership already finalized');
      if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(outcome.execution)
        || !['verified', 'unverified'].includes(outcome.cleanup)) throw new Error('Invalid build outcome');
      outcome = { execution: outcome.execution, cleanup: outcome.cleanup };
      finalized = true;
      if (await readFile(join(active, 'owner.json'), 'utf8') !== encoded) throw new Error('Ownership changed; refusing release');
      await writeReceipt(join(active, 'outcome.json'), { version: 1, runId: owner.runId, outcome, finishedAt: new Date().toISOString() });
      if (outcome.execution === 'unknown' || outcome.cleanup !== 'verified') return { released: false, recordDirectory: active };
      const archived = join(state, 'runs', owner.runId);
      await rename(active, archived);
      return { released: true, recordDirectory: archived };
    },
  });
}
