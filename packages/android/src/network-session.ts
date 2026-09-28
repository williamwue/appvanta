import { execFile as spawnCommand, spawn } from "node:child_process";
import { openSync, closeSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { platform } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from "node:url";

import type { NetworkConfig } from '@appvanta/core';

const restorationUnverified = (message: string, cause?: unknown) =>
  Object.assign(new Error(message, { cause }), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });

export async function startNetwork(config: NetworkConfig, serial: string, runDirectory: string, signal?: AbortSignal): Promise<{ stop(): Promise<void> }> {
  signal?.throwIfAborted();
  const directory = resolve(runDirectory, "network");
  const script = resolve(dirname(fileURLToPath(import.meta.url)), 'runtime/capture-network.py');
  const args = [script, "--device", serial, "--mitmdump", resolve(config.mitmdump), "--output", directory, "--controlled", "--owner-stdin", "--seconds", "3600"];
  if (config.port) args.push("--port", String(config.port));
  if (config.mapRemote) args.push("--map-remote", config.mapRemote);
  if (config.upstreamCa) args.push("--upstream-ca", resolve(config.upstreamCa));
  // A private pipe detects owner death without PID reuse ambiguity. The proxy
  // must not inherit it: only this process keeps the writer alive.
  // Detachment allows the worker to finish cleanup after its owner is killed;
  // keep its handles referenced so normal calls still await completion.
  await mkdir(resolve(runDirectory, 'logs'), { recursive: true });
  const logPath = resolve(runDirectory, 'logs/network-session.txt');
  const log = openSync(logPath, 'w');
  let child;
  try { child = spawn(config.python, args, { windowsHide: true, detached: true, stdio: ["pipe", log, log] }); }
  finally { closeSync(log); }
  let finished = false;
  let exitCode: number | null = null;
  let failure: Error | undefined;
  const completion = new Promise<void>((done) => {
    child.once("error", (error) => { failure = error; finished = true; done(); });
    child.once("close", (code) => { exitCode = code; finished = true; done(); });
  });
  const delay = () => new Promise((done) => setTimeout(done, 100));
  const stop = async () => {
    if (!finished) {
      try { await writeFile(resolve(directory, "stop.request"), "stop\n"); }
      catch (error) { throw restorationUnverified('Network stop request could not be written', error); }
    }
    await completion;
    if (failure && child.pid === undefined) throw failure;
    let summary: unknown;
    try { summary = JSON.parse(await readFile(resolve(directory, "summary.json"), "utf8")); }
    catch (error) { throw restorationUnverified('Network proxy restoration summary is unavailable', error); }
    if (!summary || typeof summary !== 'object' || !('proxyRestored' in summary) || summary.proxyRestored !== true) {
      throw restorationUnverified('Network proxy restoration was not verified');
    }
    const output = (await readFile(logPath, 'utf8')).slice(-65536);
    if (failure) throw failure;
    if (exitCode !== 0) throw new Error(`Network capture exited ${exitCode}: ${output}`);
  };
  const deadline = Date.now() + 60_000;
  while (!finished && Date.now() < deadline) {
    if (signal?.aborted) {
      try { await access(directory); } catch { await delay(); continue; }
      await stop(); signal.throwIfAborted();
    }
    try { await access(resolve(directory, "ready.json")); return { stop }; } catch { await delay(); }
  }
  if (!finished) {
    await stop();
    throw new Error("Network capture startup timed out");
  }
  await stop();
  throw failure ?? new Error("Network capture exited before readiness");
}

interface NetworkRecoveryRecord {
  readonly version: 2;
  readonly device: string;
  readonly originalProxy: string;
  readonly sessionProxy: string;
  readonly workerPid: number;
  readonly proxyPid: number;
  readonly outputRoot: string;
  readonly mitmdump: string;
  readonly port: number;
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
const isMissing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

function parseNetworkRecovery(value: unknown, serial: string, directory: string): NetworkRecoveryRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid network recovery record');
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || record.device !== serial || typeof record.originalProxy !== 'string' || typeof record.sessionProxy !== 'string' ||
      !Number.isSafeInteger(record.workerPid) || Number(record.workerPid) < 1 || !Number.isSafeInteger(record.proxyPid) || Number(record.proxyPid) < 1 ||
      typeof record.outputRoot !== 'string' || resolve(record.outputRoot) !== directory || typeof record.mitmdump !== 'string' || !isAbsolute(record.mitmdump) ||
      !Number.isInteger(record.port) || Number(record.port) < 1024 || Number(record.port) > 65535) throw new Error('Invalid or unbound network recovery record');
  if (record.sessionProxy !== `10.0.2.2:${record.port}` || !['null', ':0'].includes(String(record.originalProxy)) && !/^[^\s:]+:\d{1,5}$/.test(String(record.originalProxy))) throw new Error('Invalid network proxy recovery values');
  return record as unknown as NetworkRecoveryRecord;
}

async function commandLine(pid: number): Promise<string | null> {
  try { process.kill(pid, 0); } catch { return null; }
  try {
    const run = promisify(spawnCommand);
    if (platform() === 'win32') return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { encoding: 'utf8', timeout: 10000, windowsHide: true })).stdout.trim() || null;
    if (platform() === 'linux') return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
    return (await run('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10000, windowsHide: true })).stdout.trim() || null;
  } catch (error) { throw new Error(`Cannot verify ownership of process ${pid}: ${String(error)}`); }
}

async function stopOwnedProcess(pid: number, fragments: readonly string[]): Promise<'stopped' | 'absent'> {
  const line = await commandLine(pid);
  if (!line) return 'absent';
  const normalized = line.toLowerCase();
  if (!fragments.every(fragment => normalized.includes(fragment.toLowerCase()))) throw new Error(`Process ${pid} no longer belongs to this network session`);
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return 'stopped'; }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Network process ${pid} did not exit`);
}

/** Finish a network session after its Flow owner died, retaining external proxy changes. */
export async function recoverNetworkSession(adb: string, serial: string, runDirectory: string) {
  const directory = resolve(runDirectory, 'network');
  const summaryPath = resolve(directory, 'summary.json');
  const verifiedSummary = async () => {
    try {
      const value = await readJson(summaryPath);
      return !!value && typeof value === 'object' && (value as Record<string, unknown>).device === serial && typeof (value as Record<string, unknown>).status === 'string' && (value as Record<string, unknown>).proxyRestored === true;
    } catch (error) { if (isMissing(error)) return false; throw error; }
  };
  if (await verifiedSummary()) return { status: 'already-clean' as const, evidence: summaryPath };
  await writeFile(resolve(directory, 'stop.request'), 'recover\n');
  const cooperativeDeadline = Date.now() + 10000;
  while (Date.now() < cooperativeDeadline) {
    if (await verifiedSummary()) return { status: 'worker-cleaned' as const, evidence: summaryPath };
    await new Promise(done => setTimeout(done, 200));
  }
  const record = parseNetworkRecovery(await readJson(resolve(directory, 'recovery.json')), serial, directory);
  const adbExec = async (...args: string[]) => (await promisify(spawnCommand)(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true })).stdout.trim();
  const current = await adbExec('shell', 'settings', 'get', 'global', 'http_proxy');
  if (current !== record.originalProxy) {
    if (current !== record.sessionProxy) throw new Error('Proxy changed outside this network session; refusing recovery');
    if (record.originalProxy === 'null' || record.originalProxy === ':0') await adbExec('shell', 'settings', 'delete', 'global', 'http_proxy');
    else await adbExec('shell', 'settings', 'put', 'global', 'http_proxy', record.originalProxy);
    const restored = await adbExec('shell', 'settings', 'get', 'global', 'http_proxy');
    if (restored !== record.originalProxy && !(record.originalProxy === ':0' && restored === 'null')) throw new Error('Proxy recovery readback mismatch');
  }
  const proxy = await stopOwnedProcess(record.proxyPid, [record.mitmdump, String(record.port)]);
  const worker = await stopOwnedProcess(record.workerPid, ['capture-network.py', directory]);
  const evidence = resolve(directory, 'takeover-recovery.json');
  await writeFile(evidence, JSON.stringify({ version: 1, status: 'recovered', device: serial, originalProxy: record.originalProxy, sessionProxy: record.sessionProxy, proxyRestored: true, proxyProcess: proxy, workerProcess: worker, recoveredAt: new Date().toISOString() }, null, 2));
  return { status: 'takeover-cleaned' as const, evidence };
}
