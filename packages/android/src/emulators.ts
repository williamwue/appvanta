import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

interface EmulatorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly run?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

export async function listAndroidAvds(options: EmulatorOptions = {}) {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const sdk = env.ANDROID_SDK_ROOT || env.ANDROID_HOME;
  const executable = env.APPVANTA_EMULATOR_PATH || (sdk ? join(sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator') : 'emulator');
  const run = options.run ?? (async (file, args) => {
    const result = await promisify(execFile)(file, [...args], { env, signal: options.signal, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  const result = await run(executable, ['-list-avds']);
  options.signal?.throwIfAborted();
  const names = result.stdout.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  if (names.some(name => !/^[A-Za-z0-9_.-]+$/.test(name))) throw new Error('Emulator returned an invalid AVD name');
  return { version: 1, executable, avds: [...new Set(names)].sort().map(name => ({ name })),
    ...(result.stderr.trim() ? { diagnostics: result.stderr.trim() } : {}) };
}
