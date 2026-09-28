import { writeFile, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { captureArtifact } from './capture.js';

export async function captureScreenSegments(adb: string, device: string, directory: string, seconds: number, segmentSeconds: number,
  lifecycle: { ready(): void; stop: AbortSignal }) {
  const deadline = Date.now() + seconds * 1000;
  const segments: object[] = [];
  const save = async (status: string, error?: unknown) => {
    const temporary = join(directory, 'screen-segments.tmp');
    await writeFile(temporary, JSON.stringify({ version: 1, status, requestedSeconds: seconds, segmentSeconds, seamless: false, segments,
      ...(error ? { error: String(error) } : {}) }, null, 2));
    await rename(temporary, join(directory, 'screen-segments.json'));
  };
  let first = true;
  try {
    while (!lifecycle.stop.aborted) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining <= 0) throw new Error('Screen capture duration exhausted before Flow finalization');
      const startedAt = new Date().toISOString();
      let readyAt: string | undefined;
      await save('running');
      const result = await captureArtifact(adb, device, directory, 'screen', Math.min(segmentSeconds, remaining), undefined, {
        stop: lifecycle.stop, allowNaturalEnd: true,
        ready: () => { readyAt = new Date().toISOString(); if (first) { first = false; lifecycle.ready(); } },
      });
      segments.push({ index: segments.length, startedAt, readyAt, finishedAt: result.capturedAt, path: basename(result.path) });
      await save('running');
    }
    await save('passed');
    return { path: join(directory, 'screen-segments.json'), capturedAt: new Date().toISOString() };
  } catch (error) {
    try { await save('failed', error); }
    catch (evidenceError) {
      throw Object.assign(new AggregateError([error, evidenceError], 'Screen segment failure evidence could not be written'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
    }
    throw error;
  }
}
