import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function analyzePerfetto(options: { trace: string; packageName: string; python?: string; scenario?: string; windowMs?: number }) {
  if (!options.trace || !/^[A-Za-z0-9_.]+$/.test(options.packageName)) throw new Error('Trace and valid packageName are required');
  if (options.windowMs !== undefined && (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1)) throw new Error('windowMs must be a positive safe integer');
  const output = resolve('.appvanta/runs', `perfetto-analysis-${Date.now()}-${randomUUID()}`);
  const script = fileURLToPath(new URL('./runtime/analyze-perfetto.py', import.meta.url));
  const args = [script, '--trace', resolve(options.trace), '--package', options.packageName, '--output', output, '--scenario', options.scenario ?? 'uncontrolled-trace'];
  if (options.windowMs !== undefined) args.push('--window-ms', String(options.windowMs));
  try {
    const result = await promisify(execFile)(options.python ?? process.env.APPVANTA_PERFETTO_PYTHON ?? 'python', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
  } catch (error) {
    throw new Error(`Perfetto analysis failed; diagnostic directory: ${output}; ${String(error)}`);
  }
}
