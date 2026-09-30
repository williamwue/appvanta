import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';

type Interruption = 'aborted' | 'timeout' | 'output-limit' | 'log-failed';
type BuildProcessReceipt = {
  version: 1;
  status: 'not-started' | 'exited' | 'launch-failed' | 'exit-unconfirmed';
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errorCode: string | null;
  interruption: Interruption | null;
  forced: boolean;
  outputComplete: boolean;
  logError: string | null;
  elapsedMs: number;
  timeoutMs: number;
  cancellationGraceMs: number;
  maxOutputBytes: number;
  receivedBytes: number;
  logBytes: number;
  logSha256: string;
  logPath: string;
  descendantCleanup: 'unverified';
};
type BuildProcessOptions = {
  file: string;
  args: string[];
  cwd: string;
  logPath: string;
  timeoutMs: number;
  cancellationGraceMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
};

/** Owns only the launched process; Gradle daemon cleanup must be verified separately. */
export async function runBuildProcess(options: BuildProcessOptions): Promise<BuildProcessReceipt> {
  const { file, args, cwd, logPath, signal } = options;
  const timeoutMs = options.timeoutMs;
  const graceMs = options.cancellationGraceMs ?? 20000;
  const limit = options.maxOutputBytes ?? 4 * 1024 * 1024;
  for (const value of [timeoutMs, graceMs, limit]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Invalid build process bound');
  }
  const log = await open(logPath, 'wx', 0o600);
  const hash = createHash('sha256');
  const started = Date.now();
  let interruption: Interruption | null = null;
  let errorCode: string | null = null;
  let logError: string | null = null;
  let status: 'not-started' | 'exited' | 'launch-failed' | 'exit-unconfirmed' = 'not-started';
  let pid: number | null = null, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let retainedBytes = 0, receivedBytes = 0, outputComplete = true, forced = false;
  try {
    if (signal?.aborted) interruption = 'aborted';
    else await new Promise<void>(resolve => {
      let child: ReturnType<typeof spawn>;
      let settled = false, exited = false;
      let deadline: NodeJS.Timeout | undefined, escalation: NodeJS.Timeout | undefined;
      let forceDeadline: NodeJS.Timeout | undefined, drainDeadline: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline); clearTimeout(escalation); clearTimeout(forceDeadline); clearTimeout(drainDeadline);
        signal?.removeEventListener('abort', abort);
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        if (!exited) child.unref();
        resolve();
      };
      const cancel = (reason: Interruption) => {
        if (interruption || settled) return;
        interruption = reason;
        if (exited) return;
        child.stdin?.end();
        escalation = setTimeout(() => {
          if (exited || settled) return;
          forced = child.kill('SIGKILL');
          forceDeadline = setTimeout(() => {
            status = 'exit-unconfirmed'; outputComplete = false; finish();
          }, 5000);
        }, graceMs);
      };
      const abort = () => { if (!exited) cancel('aborted'); };
      const consume = (chunk: Buffer) => {
        if (settled) return;
        receivedBytes += chunk.length;
        if (!logError) {
          const part = chunk.subarray(0, Math.max(0, limit - retainedBytes));
          try {
            let written = 0;
            while (written < part.length) {
              const count = writeSync(log.fd, part, written, part.length - written);
              if (count === 0) throw new Error('Log write made no progress');
              hash.update(part.subarray(written, written + count)); retainedBytes += count; written += count;
            }
          } catch (error) { logError = String(error); cancel('log-failed'); }
        }
        if (receivedBytes > limit) cancel('output-limit');
      };
      try {
        child = spawn(file, args, { cwd, env: options.env ?? process.env, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        status = 'launch-failed'; errorCode = (error as NodeJS.ErrnoException).code ?? 'SPAWN_ERROR'; resolve(); return;
      }
      pid = child.pid ?? null;
      outputComplete = false;
      child.stdout!.on('data', consume); child.stderr!.on('data', consume);
      child.stdin!.on('error', error => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE') errorCode ??= (error as NodeJS.ErrnoException).code ?? 'STDIN_ERROR';
      });
      child.once('error', error => {
        errorCode = (error as NodeJS.ErrnoException).code ?? 'SPAWN_ERROR';
        if (child.pid === undefined) { status = 'launch-failed'; finish(); }
      });
      child.once('exit', (code, signalCode) => {
        if (settled) return;
        exited = true; status = 'exited'; exitCode = code; exitSignal = signalCode;
        clearTimeout(deadline); clearTimeout(escalation); clearTimeout(forceDeadline);
        drainDeadline = setTimeout(finish, 1000);
      });
      child.once('close', () => { if (!settled) { outputComplete = true; finish(); } });
      deadline = setTimeout(() => cancel('timeout'), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    await log.sync();
  } finally { await log.close(); }
  const receipt: BuildProcessReceipt = { version: 1, status, pid, exitCode, signal: exitSignal, errorCode, interruption,
    forced, outputComplete, logError, elapsedMs: Date.now() - started, timeoutMs, cancellationGraceMs: graceMs,
    maxOutputBytes: limit, receivedBytes, logBytes: retainedBytes, logSha256: hash.digest('hex'), logPath,
    descendantCleanup: 'unverified' as const };
  await writeFile(logPath + '.command.json', JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}
