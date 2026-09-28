import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { captureArtifact } from './capture.js';
import { captureScreenSegments } from './segmented-screen.js';
import type { CaptureConfig } from '@appvanta/core';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const describeError = (error: unknown): string => error instanceof AggregateError
  ? `${String(error)}: ${error.errors.map(describeError).join('; ')}`
  : String(error);

export async function startFlowCapture(config: CaptureConfig, device: string, root: string) {
  const directory = join(root, 'captures');
  await mkdir(directory, { recursive: true });
  const sessions: { kind: string; stop: AbortController; finished: Promise<void> }[] = [];
  const records: object[] = [];
  const failures: unknown[] = [];
  const token = randomUUID();
  const markers: { index: number; phase: 'begin' | 'end'; marker: string }[] = [];
  const markStep = async (index: number, phase: 'begin' | 'end') => {
    if (config.perfettoSeconds === undefined) return;
    const marker = `AppVanta:${token}:${index}:${phase}`;
    await promisify(execFile)('adb', ['-s', device, 'shell', `printf 'C|%s|${marker}|1\\n' $$ > /sys/kernel/tracing/trace_marker`], { timeout: 20000, windowsHide: true });
    markers.push({ index, phase, marker });
    await writeFile(join(directory, 'step-markers.json'), JSON.stringify({ version: 1, token, markers }, null, 2));
  };
  const finish = async () => {
    for (const session of sessions) session.stop.abort();
    await Promise.all(sessions.map(session => session.finished));
    try { await writeFile(join(directory, 'summary.json'), JSON.stringify({ status: failures.length ? 'failed' : 'passed', records }, null, 2)); }
    catch (error) { throw Object.assign(new Error('Capture finalization evidence could not be written', { cause: error }), { code: 'APPVANTA_RESTORATION_UNVERIFIED' }); }
    if (failures.length) throw new AggregateError(failures, 'Flow capture failed; see captures/summary.json');
  };
  try {
    for (const [kind, seconds] of [['screen', config.screenSeconds], ['trace', config.perfettoSeconds]] as const) {
      if (seconds === undefined) continue;
      const stop = new AbortController();
      let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const startedAt = new Date().toISOString();
      // Flow cancellation ends actions; the independent stop signal finalizes artifacts.
      const lifecycle = { ready: resolveReady, stop: stop.signal };
      const finished = (kind === 'screen' && (seconds > 180 || config.screenSegmentSeconds !== undefined)
        ? captureScreenSegments(process.env.ADB_PATH || 'adb', device, directory, seconds, config.screenSegmentSeconds ?? 180, lifecycle)
        : captureArtifact(process.env.ADB_PATH || 'adb', device, directory, kind, seconds, undefined, lifecycle))
        .then(result => { records.push({ kind, status: 'passed', startedAt, finishedAt: result.capturedAt, path: relative(root, result.path).replaceAll('\\', '/') }); })
        .catch(error => { failures.push(error); records.push({ kind, status: 'failed', startedAt, error: describeError(error) }); rejectReady(error); });
      sessions.push({ kind, stop, finished });
      // Avoid hanging if a successful natural exit races initial readiness.
      const timeout = setTimeout(() => rejectReady(new Error(`${kind} capture did not become ready within 10 seconds`)), 10000);
      try { await ready; } finally { clearTimeout(timeout); }
    }
    return { stop: finish, markStep };
  } catch (error) {
    try { await finish(); } catch (cleanup) {
      const unverified = failures.some(failure => !!failure && typeof failure === 'object' && 'code' in failure && failure.code === 'APPVANTA_RESTORATION_UNVERIFIED') || !!cleanup && typeof cleanup === 'object' && 'code' in cleanup && cleanup.code === 'APPVANTA_RESTORATION_UNVERIFIED';
      throw Object.assign(new AggregateError([error, cleanup], `Capture setup and cleanup failed: ${describeError(error)}; ${describeError(cleanup)}`), unverified ? { code: 'APPVANTA_RESTORATION_UNVERIFIED' } : {});
    }
    throw error;
  }
}
