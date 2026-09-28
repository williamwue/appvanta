import { setTimeout as delay } from 'node:timers/promises';
import { runAndroidFlows } from '@appvanta/android';
import type { BatchStore } from '@appvanta/core';

export async function runPersistedBatch(batchId: string, batchStore: BatchStore): Promise<void> {
  const batch = await batchStore.get(batchId);
  if (batch.owner.pid !== process.pid) throw new Error('Persisted batch worker does not own the batch');
  const controller = new AbortController();
  let finished = false, monitorFailure: unknown;
  const monitor = (async () => {
    try {
      while (!finished) {
        if (await batchStore.cancellationRequested(batch.id)) { controller.abort(new Error('Persisted batch cancellation request')); return; }
        await delay(200);
      }
    } catch (error) { monitorFailure = error; controller.abort(error); }
  })();
  try {
    if (await batchStore.cancellationRequested(batch.id)) throw new Error('Persisted batch cancellation request');
    batch.status = 'running'; await batchStore.save(batch);
    const result = await runAndroidFlows(batch.deviceIds, batch.flow, batch.concurrency, controller.signal);
    batch.result = result; batch.runDirectory = result.runDirectory;
    batch.status = result.status === 'passed' || result.status === 'failed' || result.status === 'cancelled' ? result.status : 'failed';
  } catch (error) {
    batch.status = controller.signal.aborted || await batchStore.cancellationRequested(batch.id) ? 'cancelled' : 'failed';
    batch.error = String(error);
  } finally {
    finished = true; await monitor;
    if (monitorFailure) { batch.status = 'failed'; batch.error = `Cancellation monitor failed: ${String(monitorFailure)}`; }
    batch.finishedAt = new Date().toISOString(); await batchStore.save(batch);
  }
}
