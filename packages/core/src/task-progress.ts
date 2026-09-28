import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TaskStore } from './tasks.js';
import { TaskInstructionStore } from './task-instructions.js';
import { inspectFlowProgress } from './flow-progress.js';

export async function inspectTaskProgress(store: TaskStore, taskId: string) {
  const task = await store.get(taskId);
  if (!task.runDirectory) throw new Error('Task has no bound run directory');
  const root = await realpath(task.runDirectory);
  const flow = JSON.parse(await readFile(join(root, 'flow.json'), 'utf8'));
  if (!isDeepStrictEqual(task.flow, flow)) throw new Error('Task Flow differs from bound run');
  const instructions = await new TaskInstructionStore(store).list(taskId);
  const progress = await inspectFlowProgress(root, instructions);
  if (progress.deviceId !== task.deviceId) throw new Error('Task device differs from bound run');
  const reasons = [...progress.reasons];
  if (task.status !== 'interrupted') reasons.push(`task-${task.status}`);
  if (await store.cancellationRequested(taskId)) reasons.push('cancellation-requested');
  return { ...progress, taskId, taskStatus: task.status, queuedInstructions: instructions.filter(item => item.status === 'queued').map(item => item.id), reasons, boundaryConsistent: reasons.length === 0 };
}
