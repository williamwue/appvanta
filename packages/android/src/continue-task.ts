import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { claimTaskContinuation, emitTaskCompletion, TaskStore, TaskInstructionStore } from '@appvanta/core';
import { continueAndroidFlow } from './recover-flow.js';
import { runAndroidFlow } from './flow.js';
import { archiveCancelledContinuation } from './retry-continuation.js';

export async function continueAndroidTask(store: TaskStore, taskId: string, leaseToken: string, checkpoint: unknown, signal?: AbortSignal, onTaskCreated?: (taskId: string) => Promise<void>, validateSource?: () => Promise<void>) {
  const original = await store.get(taskId);
  if (!original.runDirectory) throw new Error('Task has no source run');
  const sourceRun = await realpath(original.runDirectory);
  let reservation: Awaited<ReturnType<typeof claimTaskContinuation>> | undefined;
  return continueAndroidFlow(original.deviceId, leaseToken, async recoveredRun => {
    if (!reservation || recoveredRun !== sourceRun) throw new Error('Continuation source changed');
    await validateSource?.();
    signal?.throwIfAborted();
    const task = await store.create(original.deviceId, reservation.claim.flow);
    await writeFile(join(reservation.directory, 'successor.json'), JSON.stringify({ taskId: task.id }, null, 2), { flag: 'wx' });
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const instructions = new TaskInstructionStore(store);
    const saveCompletion = async () => {
      if (!task.finishedAt || !['passed', 'failed', 'cancelled'].includes(task.status)) throw new Error('Continuation has no terminal result');
      task.notification = await emitTaskCompletion(join(store.directory, task.id), {
        version: 1, type: 'task.completed', taskId: task.id,
        status: task.status as 'passed' | 'failed' | 'cancelled', finishedAt: task.finishedAt,
        ...(task.runDirectory ? { runDirectory: task.runDirectory } : {}),
      });
      await store.save(task);
    };
    let checkpointPending = true;
    let readinessPending = true;
    let polling: Promise<void> | undefined;
    const poll = async () => {
      if (await store.cancellationRequested(task.id)) controller.abort(new Error('Task cancellation requested'));
    };
    const timer = setInterval(() => {
      if (!polling) polling = poll().catch(error => controller.abort(error)).finally(() => { polling = undefined; });
    }, 200);
    try {
      task.status = 'running'; await store.save(task);
      const result = await runAndroidFlow(task.deviceId, task.flow, controller.signal, async root => {
        task.runDirectory = root;
        await writeFile(join(root, 'continuation.json'), JSON.stringify(reservation!.claim, null, 2), { flag: 'wx' });
        await store.save(task);
      }, {
        drain: async () => {
          if (checkpointPending) { checkpointPending = false; return []; }
          return (await instructions.claimQueued(task.id)).map(item => ({ id: item.id, step: item.step }));
        },
        finish: async (id, status, error) => { await instructions.finish(task.id, id, status, error); },
        beforeStep: async () => {
          await poll(); controller.signal.throwIfAborted();
          if (readinessPending) {
            await onTaskCreated?.(task.id);
            readinessPending = false;
            controller.signal.throwIfAborted();
          }
          while (await store.pauseRequested(task.id)) {
            if (task.status !== 'paused') { task.status = 'paused'; await store.save(task); }
            await delay(100, undefined, { signal: controller.signal });
            await poll(); controller.signal.throwIfAborted();
          }
          if (task.status === 'paused') { task.status = 'running'; await store.save(task); }
        },
      });
      task.status = result.status; task.result = result; task.finishedAt = new Date().toISOString();
      await saveCompletion();
      if (result.status !== 'passed') throw new Error(`Continuation ${task.id} ${result.status}; device lease retained for inspection`);
      return { taskId: task.id, sourceTaskId: original.id, ...result };
    } catch (error) {
      if (!task.finishedAt) {
        task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.error = String(error);
        task.finishedAt = new Date().toISOString(); await saveCompletion();
      }
      throw error;
    } finally {
      clearInterval(timer); await polling;
      signal?.removeEventListener('abort', abort);
    }
  }, async lease => {
    signal?.throwIfAborted();
    await validateSource?.();
    if (!lease.runDirectory || await realpath(lease.runDirectory) !== sourceRun) throw new Error('Task does not match abandoned device lease');
    await archiveCancelledContinuation(join(store.directory, taskId, 'continuation'), taskId, original.deviceId, leaseToken);
    reservation = await claimTaskContinuation(store, taskId, checkpoint);
  }, signal, async () => {
    if (!reservation) throw new Error('Missing cancelled continuation reservation');
    await writeFile(join(reservation.directory, 'cancelled-before-transfer.json'), JSON.stringify({
      version: 1, phase: 'cleanup-complete-before-transfer', claimId: reservation.claim.id,
      taskId, leaseToken, cancelledAt: new Date().toISOString(),
    }, null, 2), { flag: 'wx' });
  });
}
