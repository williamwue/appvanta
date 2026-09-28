import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listAndroidAvds } from './emulators.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';
export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly detail?: string;
  readonly remediation?: string;
}
export interface DoctorReport {
  readonly version: 1;
  readonly verdict: 'ready' | 'degraded' | 'blocked';
  readonly checks: readonly DoctorCheck[];
  readonly fixes: readonly string[];
  readonly summary: { readonly passed: number; readonly warnings: number; readonly failures: number };
}

interface CommandResult { readonly stdout: string; readonly stderr: string }
interface DoctorOptions {
  readonly root: string;
  readonly fix?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly nodeVersion?: string;
  readonly run?: (file: string, args: readonly string[]) => Promise<CommandResult>;
}

const detail = (value: string) => value.trim().split(/\r?\n/).filter(Boolean).slice(0, 4).join('; ');
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);
const atLeast = (value: readonly number[], minimum: readonly number[]) => {
  for (let index = 0; index < Math.max(value.length, minimum.length); index++) {
    if ((value[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((value[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
};

export async function inspectAndroidEnvironment(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const fixes: string[] = [];
  const environment = options.env ?? process.env;
  const run = options.run ?? (async (file, args) => {
    const result = await promisify(execFile)(file, [...args], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: environment });
    return { stdout: result.stdout, stderr: result.stderr };
  });

  const nodeVersion = options.nodeVersion ?? process.version;
  const nodeMajor = Number(/^v(\d+)/.exec(nodeVersion)?.[1]);
  checks.push(Number.isSafeInteger(nodeMajor) && nodeMajor >= 20
    ? { id: 'node', status: 'pass', message: `Node.js ${nodeVersion}` }
    : { id: 'node', status: 'fail', message: `Node.js 20 or newer is required; found ${nodeVersion}`, remediation: 'Install Node.js 20 or newer.' });

  const workspaceDirectories = ['runs', 'tasks', 'cli-artifacts'].map(name => join(options.root, '.appvanta', name));
  if (options.fix) {
    try {
      for (const directory of workspaceDirectories) await mkdir(directory, { recursive: true });
      fixes.push('Created AppVanta runtime directories');
    } catch (error) {
      checks.push({ id: 'workspace', status: 'fail', message: 'Cannot create AppVanta runtime directories', detail: failureText(error), remediation: `Grant write access to ${options.root}.` });
    }
  }
  if (!checks.some(check => check.id === 'workspace')) {
    try {
      await access(options.root, constants.R_OK | constants.W_OK);
      checks.push({ id: 'workspace', status: 'pass', message: `Workspace is readable and writable: ${options.root}` });
    } catch (error) {
      checks.push({ id: 'workspace', status: 'fail', message: `Workspace is not accessible: ${options.root}`, detail: failureText(error), remediation: 'Run AppVanta from a readable and writable project directory.' });
    }
  }

  let adbAvailable = false;
  const adb = environment.ADB_PATH || 'adb';
  try {
    const result = await run(adb, ['version']);
    const version = detail(`${result.stdout}\n${result.stderr}`);
    if (!/Android Debug Bridge version/i.test(version)) throw new Error(`Unexpected output: ${version}`);
    const parsed = /Android Debug Bridge version\s+(\d+)\.(\d+)\.(\d+)/i.exec(version)?.slice(1).map(Number);
    if (!parsed || !atLeast(parsed, [1, 0, 41])) throw new Error(`ADB 1.0.41 or newer is required; found ${version}`);
    adbAvailable = true;
    checks.push({ id: 'adb', status: 'pass', message: 'ADB is available', detail: version });
  } catch (error) {
    checks.push({ id: 'adb', status: 'fail', message: 'ADB is unavailable', detail: failureText(error), remediation: 'Install Android SDK Platform-Tools and add adb to PATH.' });
  }

  if (adbAvailable && options.fix) {
    try { await run(adb, ['start-server']); fixes.push('Started ADB server'); }
    catch (error) { checks.push({ id: 'adb-server', status: 'fail', message: 'Could not start ADB server', detail: failureText(error), remediation: 'Stop conflicting ADB processes and retry.' }); }
  }

  if (adbAvailable) {
    try {
      const result = await run(adb, ['devices', '-l']);
      const deviceLines = result.stdout.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean);
      const online = deviceLines.filter(line => /^\S+\s+device(?:\s|$)/.test(line)).length;
      const unavailable = deviceLines.length - online;
      checks.push(online > 0
        ? { id: 'devices', status: 'pass', message: `${online} online Android device(s)`, ...(unavailable ? { detail: `${unavailable} unauthorized/offline device(s)` } : {}) }
        : { id: 'devices', status: 'warn', message: 'No online Android device or emulator', ...(unavailable ? { detail: `${unavailable} unauthorized/offline device(s)` } : {}), remediation: 'Start an emulator or connect and authorize a device before running Android flows.' });
    } catch (error) {
      checks.push({ id: 'devices', status: 'warn', message: 'Could not enumerate Android devices', detail: failureText(error), remediation: 'Run adb devices -l and resolve server or authorization errors.' });
    }
  }

  const sdkRoot = environment.ANDROID_SDK_ROOT || environment.ANDROID_HOME;
  if (!sdkRoot) {
    checks.push({ id: 'android-sdk', status: 'warn', message: 'ANDROID_SDK_ROOT/ANDROID_HOME is not set', remediation: 'Set an Android SDK environment variable for builds and test-tool compilation.' });
  } else {
    try {
      if (!(await stat(sdkRoot)).isDirectory()) throw new Error('Path is not a directory');
      checks.push({ id: 'android-sdk', status: 'pass', message: `Android SDK: ${sdkRoot}` });
    } catch (error) {
      checks.push({ id: 'android-sdk', status: 'warn', message: `Android SDK path is invalid: ${sdkRoot}`, detail: failureText(error), remediation: 'Point ANDROID_SDK_ROOT or ANDROID_HOME to an installed Android SDK.' });
    }
  }

  try {
    const inventory = await listAndroidAvds({ env: environment, run });
    checks.push(inventory.avds.length
      ? { id: 'avds', status: 'pass', message: `${inventory.avds.length} configured Android virtual device(s)`, detail: inventory.avds.map(avd => avd.name).join(', ') }
      : { id: 'avds', status: 'warn', message: 'No configured Android virtual devices', remediation: 'Create an AVD using Android Studio Device Manager, or connect an authorized physical device.' });
  } catch (error) {
    checks.push({ id: 'avds', status: 'warn', message: 'Android emulator inventory unavailable', detail: failureText(error), remediation: 'Install the Android Emulator SDK component, set ANDROID_SDK_ROOT/ANDROID_HOME or APPVANTA_EMULATOR_PATH; physical ADB devices remain usable.' });
  }

  for (const tool of [
    { id: 'python', file: 'python', args: ['--version'], purpose: 'network and Perfetto helpers', minimum: [3, 10], pattern: /Python\s+(\d+)\.(\d+)/i, remediation: 'Install Python 3.10 or newer to use network and Perfetto helpers.' },
    { id: 'java', file: 'java', args: ['-version'], purpose: 'Android project builds', minimum: [17], pattern: /version\s+"(\d+)/i, remediation: 'Install JDK 17 or newer to build AppVanta Android test helpers.' },
  ]) {
    try {
      const result = await run(tool.file, tool.args);
      const output = detail(`${result.stdout}\n${result.stderr}`);
      const version = tool.pattern.exec(output)?.slice(1).map(Number);
      if (!version || !atLeast(version, tool.minimum)) throw new Error(`${tool.file} ${tool.minimum.join('.')} or newer is required; found ${output || 'unknown version'}`);
      checks.push({ id: tool.id, status: 'pass', message: `${tool.file} meets the supported version`, detail: output });
    } catch (error) {
      checks.push({ id: tool.id, status: 'warn', message: `${tool.file} is unavailable; ${tool.purpose} are limited`, detail: failureText(error), remediation: tool.remediation });
    }
  }

  const summary = {
    passed: checks.filter(check => check.status === 'pass').length,
    warnings: checks.filter(check => check.status === 'warn').length,
    failures: checks.filter(check => check.status === 'fail').length,
  };
  const verdict = summary.failures ? 'blocked' : summary.warnings ? 'degraded' : 'ready';
  return { version: 1, verdict, checks, fixes, summary };
}
