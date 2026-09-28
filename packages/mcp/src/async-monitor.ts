import { appendFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AdbDriver } from '@appvanta/android';
import { brand, withDeviceLock, type MonitorStore } from '@appvanta/core';

export async function runPersistedMonitor(monitorId: string, monitorStore: MonitorStore): Promise<void> {
  const record = await monitorStore.get(monitorId);
  if (record.owner.pid !== process.pid) throw new Error('Persisted monitor worker does not own the monitor');
  const controller = new AbortController(), driver = new AdbDriver({ artifactsDirectory: resolve(record.rootDirectory, 'artifacts'), signal: controller.signal });
  const deadline = Date.parse(record.startedAt) + record.durationMs;
  let finished = false, monitorFailure: unknown;
  const releaseMonitor = (async () => {
    try {
      while (!finished) {
        if (await monitorStore.releaseRequested(record.id)) { controller.abort(new Error('Persisted monitor release request')); return; }
        await delay(200);
      }
    } catch (error) { monitorFailure = error; controller.abort(error); }
  })();
  try {
    record.status = 'running'; await monitorStore.save(record);
    while (Date.now() < deadline) {
      if (await monitorStore.releaseRequested(record.id)) { record.status = 'released'; break; }
      const observation = await withDeviceLock(record.deviceId, () => driver.observe(brand<string, 'DeviceId'>(record.deviceId)));
      record.sampleCount++; record.lastCapturedAt = observation.capturedAt;
      const portable = { index: record.sampleCount, capturedAt: observation.capturedAt, screenshotPath: observation.screenshotPath ? relative(record.rootDirectory, observation.screenshotPath).replaceAll('\\', '/') : undefined, uiTreePath: observation.uiTreePath ? relative(record.rootDirectory, observation.uiTreePath).replaceAll('\\', '/') : undefined, uiDescriptionPath: observation.uiDescriptionPath ? relative(record.rootDirectory, observation.uiDescriptionPath).replaceAll('\\', '/') : undefined };
      await appendFile(resolve(record.rootDirectory, 'observations.jsonl'), `${JSON.stringify(portable)}\n`, 'utf8'); await monitorStore.save(record);
      const next = Math.min(deadline, Date.now() + record.intervalMs);
      while (Date.now() < next) {
        if (await monitorStore.releaseRequested(record.id)) { record.status = 'released'; break; }
        await delay(Math.min(200, next - Date.now()), undefined, { signal: controller.signal });
      }
      if (record.status === 'released') break;
    }
    if (record.status === 'running') record.status = 'completed';
  } catch (error) {
    if (await monitorStore.releaseRequested(record.id)) record.status = 'released';
    else { record.status = 'failed'; record.error = String(error); }
  } finally {
    finished = true; await releaseMonitor;
    if (monitorFailure) { record.status = 'failed'; record.error = `Release monitor failed: ${String(monitorFailure)}`; }
    record.finishedAt = new Date().toISOString(); await monitorStore.save(record);
  }
}
