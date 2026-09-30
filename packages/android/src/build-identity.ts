import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuildProcess } from './build-process.js';

type IdentityObservation = {
  version: 1; pid: number; expectedStartEpochMillis: number;
  observedStartEpochMillis: number | null;
  state: 'matching' | 'different' | 'absent' | 'unknown';
};

export function validateBuildIdentityObservation(value: unknown, expected: { pid: number; startEpochMillis: number }): IdentityObservation {
  if (![expected.pid, expected.startEpochMillis].every(item => Number.isSafeInteger(item) && item > 0)) throw new Error('Invalid expected process identity');
  if (!value || typeof value !== 'object') throw new Error('Invalid process identity observation');
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || item.pid !== expected.pid || item.expectedStartEpochMillis !== expected.startEpochMillis
    || typeof item.state !== 'string' || !['matching', 'different', 'absent', 'unknown'].includes(item.state)
    || !(item.observedStartEpochMillis === null || Number.isSafeInteger(item.observedStartEpochMillis) && Number(item.observedStartEpochMillis) > 0)) throw new Error('Invalid process identity observation');
  if (item.state === 'matching' && item.observedStartEpochMillis !== expected.startEpochMillis
    || item.state === 'different' && (item.observedStartEpochMillis === null || item.observedStartEpochMillis === expected.startEpochMillis)) throw new Error('Contradictory process identity observation');
  return item as IdentityObservation;
}

/** Read-only snapshot, not an authorization to signal a PID or release project ownership. */
export async function inspectBuildProcessIdentity(options: {
  java: string; pid: number; startEpochMillis: number; outputPath: string;
}) {
  if (![options.pid, options.startEpochMillis].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid expected process identity');
  const outputPath = resolve(options.outputPath);
  const source = join(dirname(fileURLToPath(import.meta.url)), 'runtime', 'BuildProcessIdentity.java');
  const command = await runBuildProcess({ file: options.java, args: [source, String(options.pid), String(options.startEpochMillis),
    Buffer.from(outputPath, 'utf8').toString('base64')], cwd: dirname(outputPath), logPath: outputPath + '.log', timeoutMs: 30000 });
  if (command.status !== 'exited' || command.exitCode !== 0 || command.interruption || command.logError || !command.outputComplete) {
    return { state: 'unknown' as const, command, observation: null };
  }
  try {
    const observation = validateBuildIdentityObservation(JSON.parse(await readFile(outputPath, 'utf8')), options);
    return { state: observation.state, command, observation };
  } catch {
    return { state: 'unknown' as const, command, observation: null };
  }
}
