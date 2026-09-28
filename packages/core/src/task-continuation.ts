import { mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { TaskStore } from './tasks.js';
import { TaskInstructionStore } from './task-instructions.js';
import { inspectTaskProgress } from './task-progress.js';
import { prepareFlowContinuation } from './flow-progress.js';

export async function claimTaskContinuation(store: TaskStore, taskId: string, checkpoint: unknown, timeoutMs = 10000) {
  const initial = await inspectTaskProgress(store, taskId);
  if (!initial.boundaryConsistent) throw new Error(`Task cannot continue: ${initial.reasons.join(', ')}`);
  const task = await store.get(taskId);
  const sourceRun = await realpath(task.runDirectory!);
  const instructions = await new TaskInstructionStore(store).list(taskId);
  const prepared = await prepareFlowContinuation(sourceRun, checkpoint, instructions, timeoutMs);
  const directory = join(store.directory, taskId, 'continuation');
  // Never erase this reservation on failure: a successor may already have acted.
  await mkdir(directory);
  const current = await inspectTaskProgress(store, taskId);
  if (!current.boundaryConsistent || current.revision !== prepared.source.revision) throw new Error('Task changed while reserving continuation');
  const claim = { version: 1, id: randomUUID(), sourceTaskId: taskId, deviceId: task.deviceId,
    owner: { pid: process.pid, host: hostname() }, createdAt: new Date().toISOString(),
    ...prepared };
  const handle = await open(join(directory, 'claim.json'), 'wx');
  try { await handle.writeFile(JSON.stringify(claim, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  return { directory, claim };
}
