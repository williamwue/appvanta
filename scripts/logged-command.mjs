import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

export async function runLoggedCommand({ file, args, cwd, env = process.env, logPath, timeoutMs, maxBuffer = 4 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Positive command timeout required');
  const started = Date.now();
  let stdout = '', stderr = '', error, timedOut = false, escalation;
  const pending = promisify(execFile)(file, args, { cwd, env, windowsHide: true, encoding: 'utf8', maxBuffer });
  const timeout = setTimeout(() => {
    timedOut = true;
    pending.child.kill();
    escalation = setTimeout(() => pending.child.kill('SIGKILL'), 1000);
  }, timeoutMs);
  try {
    ({ stdout, stderr } = await pending);
  } catch (failure) {
    error = failure;
    stdout = failure.stdout ?? '';
    stderr = failure.stderr ?? '';
  } finally { clearTimeout(timeout); clearTimeout(escalation); }
  const status = timedOut ? 'interrupted' : error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit' : error?.killed || error?.signal ? 'interrupted' : !error || typeof error.code === 'number' ? 'exited' : 'launch-failed';
  const log = `${stdout}\n${stderr}`;
  await writeFile(logPath, log);
  const receipt = {
    version: 1, status, exitCode: !error ? 0 : typeof error.code === 'number' ? error.code : null,
    signal: error?.signal ?? null, errorCode: typeof error?.code === 'string' ? error.code : null,
    killed: pending.child.killed, timedOut, elapsedMs: Date.now() - started, timeoutMs,
    descendantCleanup: 'unverified', logPath,
    logBytes: Buffer.byteLength(log), logSha256: createHash('sha256').update(log).digest('hex'),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
  };
  await writeFile(logPath + '.command.json', JSON.stringify(receipt, null, 2));
  return receipt;
}
