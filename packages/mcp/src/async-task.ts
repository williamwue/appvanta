import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAndroidFlow } from '@appvanta/android';
import { brand, emitTaskCompletion, TaskInstructionStore, terminalTask, type DeviceId, type TaskRecord, type TaskStore } from '@appvanta/core';

export async function runPersistedTask(taskId: string, taskStore: TaskStore, webhookOrigins: readonly string[], webhookSigningSecret?: string): Promise<void> {
  const task = await taskStore.get(taskId);
  if (terminalTask(task.status)) return;
  if (task.owner.pid !== process.pid) throw new Error('Persisted task worker does not own the task');
  const taskInstructions = new TaskInstructionStore(taskStore), controller = new AbortController();
  let finished = false, monitorFailure: unknown;
  const monitor = (async () => {
    try {
      while (!finished) {
        if (await taskStore.cancellationRequested(taskId)) { controller.abort(new Error('Persisted cancellation request')); return; }
        await delay(200);
      }
    } catch (error) { monitorFailure = error; controller.abort(error); }
  })();
  try {
    if (await taskStore.cancellationRequested(taskId)) throw new Error('Persisted cancellation request');
    task.status = 'running'; await taskStore.save(task);
    const result = await runAndroidFlow(brand<string, 'DeviceId'>(task.deviceId), task.flow, controller.signal, async root => {
      task.runDirectory = root; await taskStore.save(task);
    }, {
      drain: async () => (await taskInstructions.claimQueued(taskId)).map(record => ({ id: record.id, step: record.step })),
      finish: async (id, status, error) => { await taskInstructions.finish(taskId, id, status, error); },
      beforeStep: async () => {
        if (!await taskStore.pauseRequested(taskId)) return;
        task.status = 'paused'; await taskStore.save(task);
        while (await taskStore.pauseRequested(taskId)) {
          if (await taskStore.cancellationRequested(taskId)) controller.abort(new Error('Persisted cancellation request'));
          await delay(200, undefined, { signal: controller.signal });
        }
        task.status = 'running'; await taskStore.save(task);
      },
    });
    task.result = result; task.status = result.status;
  } catch (error) {
    task.status = controller.signal.aborted || await taskStore.cancellationRequested(taskId) ? 'cancelled' : 'failed';
    task.error = String(error);
  } finally {
    finished = true; await monitor;
    if (monitorFailure) { task.status = 'failed'; task.error = `Cancellation monitor failed: ${String(monitorFailure)}`; }
    task.finishedAt = new Date().toISOString();
    if (task.status === 'passed' || task.status === 'failed' || task.status === 'cancelled') task.notification = await emitTaskCompletion(join(taskStore.directory, taskId), { version: 1, type: 'task.completed', taskId, status: task.status, finishedAt: task.finishedAt, ...(task.runDirectory ? { runDirectory: task.runDirectory } : {}) }, { ...(task.completionWebhook ? { webhookUrl: task.completionWebhook, allowedOrigins: webhookOrigins } : {}), ...(webhookSigningSecret ? { signingSecret: webhookSigningSecret } : {}) });
    await taskStore.save(task);
  }
}
