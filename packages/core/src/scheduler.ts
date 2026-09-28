export interface DeviceTaskResult<T> { readonly deviceId: string; readonly status: "passed" | "failed" | "cancelled"; readonly value?: T; readonly error?: string }

/** Runs one isolated task per device and returns every result, including failures. */
export async function runOnDevices<T>(deviceIds: readonly string[], task: (deviceId: string) => Promise<T>, options: { concurrency?: number; signal?: AbortSignal; status?: (value: T) => DeviceTaskResult<T>['status'] } = {}): Promise<readonly DeviceTaskResult<T>[]> {
  if (!deviceIds.length || deviceIds.some(id => !id.trim()) || new Set(deviceIds).size !== deviceIds.length) throw new Error('Device ids must be non-empty and unique');
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Concurrency must be an integer from 1 to 32');
  const results: DeviceTaskResult<T>[] = new Array(deviceIds.length);
  let next = 0;
  async function worker() {
    while (next < deviceIds.length) {
      const index = next++;
      const deviceId = deviceIds[index]!;
      if (options.signal?.aborted) { results[index] = { deviceId, status: 'cancelled', error: 'Cancelled before dispatch' }; continue; }
      try {
        const value = await task(deviceId);
        results[index] = { deviceId, status: options.status?.(value) ?? 'passed', value };
      } catch (error) {
        results[index] = { deviceId, status: options.signal?.aborted ? 'cancelled' : 'failed', error: String(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, deviceIds.length) }, worker));
  return results;
}
