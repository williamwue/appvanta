import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function analyzePerfetto(options: { trace: string; packageName: string; python?: string; scenario?: string; windowMs?: number; signal?: AbortSignal }) {
  options.signal?.throwIfAborted();
  if (!options.trace || !/^[A-Za-z0-9_.]+$/.test(options.packageName)) throw new Error('Trace and valid packageName are required');
  if (options.windowMs !== undefined && (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1)) throw new Error('windowMs must be a positive safe integer');
  const output = resolve('.appvanta/runs', `perfetto-analysis-${Date.now()}-${randomUUID()}`);
  const script = fileURLToPath(new URL('./runtime/analyze-perfetto.py', import.meta.url));
  const cancelFile = `${output}.cancel`;
  const args = [script, '--trace', resolve(options.trace), '--package', options.packageName, '--output', output, '--scenario', options.scenario ?? 'uncontrolled-trace', '--cancel-file', cancelFile];
  if (options.windowMs !== undefined) args.push('--window-ms', String(options.windowMs));
  await mkdir(dirname(output), { recursive: true });
  options.signal?.throwIfAborted();
  let cancellation = Promise.resolve(), cancellationError: unknown;
  const cancel = () => { cancellation = writeFile(cancelFile, JSON.stringify({ requestedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }).catch(error => { cancellationError = error; }); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    options.signal?.throwIfAborted();
    const result = await promisify(execFile)(options.python ?? process.env.APPVANTA_PERFETTO_PYTHON ?? 'python', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    options.signal?.throwIfAborted();
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
  } catch (error) {
    await cancellation;
    throw new Error(`Perfetto analysis ${options.signal?.aborted ? 'cancellation requested' : 'failed'}; diagnostic directory: ${output}; ${String(error)}${cancellationError ? `; cancellation delivery failed: ${String(cancellationError)}` : ''}`);
  } finally { options.signal?.removeEventListener('abort', cancel); await cancellation; }
}
