import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

interface CaptureRecoveryRecord {
  readonly version: 2;
  readonly kind: 'screen' | 'trace';
  readonly device: string;
  readonly artifact: string;
  readonly remote: string;
  readonly control: string;
  readonly seconds: number;
  readonly status: 'starting' | 'running' | 'passed' | 'failed' | 'recovered';
  readonly cancelled: boolean;
  readonly cleaned: boolean;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly cleanupError?: string;
  readonly transportErrors?: readonly TransportError[];
}

interface TransportError {
  readonly phase: 'capture-ownership' | 'recovery-ownership' | 'capture-pull' | 'recovery-pull';
  readonly attempt: number;
  readonly code: string | number | null;
  readonly killed: boolean;
  readonly signal: string | null;
  readonly elapsedMs: number;
  readonly stderr?: string;
}

function recordTransportError(errors: TransportError[], phase: TransportError['phase'], attempt: number, started: number, error: unknown): void {
  const detail = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderr?: unknown };
  errors.push({ phase, attempt, code: typeof detail?.code === 'string' || typeof detail?.code === 'number' ? detail.code : null,
    killed: detail?.killed === true, signal: detail?.signal ?? null, elapsedMs: Date.now() - started,
    ...(typeof detail?.stderr === 'string' ? { stderr: detail.stderr.slice(0, 4096) } : {}) });
}

async function probeOwnership(exec: (args: string[]) => Promise<string>, pid: string, remote: string, phase: TransportError['phase'], errors: TransportError[]): Promise<boolean> {
  const command = `if [ -r /proc/${pid}/cmdline ]; then tr '\\000' ' ' < /proc/${pid}/cmdline 2>/dev/null || true; fi`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try { return (await exec(['shell', command])).includes(remote); }
    catch (error) {
      const detail = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      recordTransportError(errors, phase, attempt, started, error);
      if (attempt === 2 || !(detail.code === 'ETIMEDOUT' || (detail.killed === true && detail.signal === 'SIGTERM'))) throw error;
    }
  }
  throw new Error('Capture ownership probe exhausted');
}

const captureName = /^(screen|trace)-[a-f0-9-]{36}\.(mp4|perfetto-trace)$/;

function parseRecoveryRecord(value: unknown, device: string): CaptureRecoveryRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid capture recovery record');
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || record.device !== device || (record.kind !== 'screen' && record.kind !== 'trace') ||
      typeof record.artifact !== 'string' || !captureName.test(record.artifact) || typeof record.remote !== 'string' ||
      typeof record.control !== 'string' || !Number.isInteger(record.seconds) || Number(record.seconds) < 1 || Number(record.seconds) > 180 ||
      !['starting', 'running', 'passed', 'failed', 'recovered'].includes(String(record.status)) ||
      typeof record.cancelled !== 'boolean' || typeof record.cleaned !== 'boolean' || typeof record.startedAt !== 'string') {
    throw new Error('Invalid or unbound capture recovery record');
  }
  const expectedRemote = `${record.kind === 'screen' ? '/sdcard' : '/data/misc/perfetto-traces'}/${record.artifact}`;
  const expectedControl = `/data/local/tmp/appvanta-${record.artifact}`;
  if (!record.artifact.startsWith(`${record.kind}-`) || record.remote !== expectedRemote || record.control !== expectedControl || !Number.isFinite(Date.parse(record.startedAt))) throw new Error('Capture recovery paths do not match artifact');
  return record as unknown as CaptureRecoveryRecord;
}

// Startup and cleanup deliberately outlive caller cancellation. Only this capture's
// PID and unique output marker may be signalled; never kill all screenrecord/perfetto.
export async function captureArtifact(adb: string, device: string, directory: string, kind: 'screen' | 'trace', seconds: number, signal?: AbortSignal, lifecycle?: { ready(): void; stop: AbortSignal; allowNaturalEnd?: boolean }) {
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true });
  const name = `${kind}-${randomUUID()}.${kind === 'screen' ? 'mp4' : 'perfetto-trace'}`;
  const remote = `${kind === 'screen' ? '/sdcard' : '/data/misc/perfetto-traces'}/${name}`;
  const control = `/data/local/tmp/appvanta-${name}`;
  const path = join(directory, name);
  const exec = async (args: string[], timeout = 20000) => (await promisify(execFile)(adb, ['-s', device, ...args], { encoding: 'utf8', timeout, windowsHide: true })).stdout.trim();
  const shell = (command: string) => exec(['shell', command]);
  const command = kind === 'screen' ? `screenrecord --time-limit ${seconds} ${remote}` : `perfetto -o ${remote} -t ${seconds}s sched freq am wm`;
  const child = `echo $$ > ${control}.pid; exec ${command}`;
  const wrapper = `sh -c ${quote(child)}; echo $? > ${control}.status`;
  let failure: unknown;
  let cleanupError: unknown;
  let ready = false;
  let forced = false;
  const transportErrors: TransportError[] = [];
  const startedAt = new Date().toISOString();
  const evidencePath = `${path}.capture.json`;
  const save = (record: Omit<CaptureRecoveryRecord, 'version' | 'kind' | 'device' | 'artifact' | 'remote' | 'control' | 'seconds' | 'startedAt'>) =>
    writeFile(evidencePath, JSON.stringify({ version: 2, kind, device, artifact: name, remote, control, seconds, startedAt, ...record }, null, 2));
  // Persist recovery coordinates before the first device-side process is started.
  await save({ status: 'starting', cancelled: false, cleaned: false });
  try {
    await shell(`nohup sh -c ${quote(wrapper)} > ${control}.log 2>&1 < /dev/null &`);
    await save({ status: 'running', cancelled: false, cleaned: false });
    const deadline = Date.now() + seconds * 1000 + 20000;
    while (true) {
      signal?.throwIfAborted();
      const status = await shell(`if [ -f ${control}.status ]; then cat ${control}.status; fi`);
      if (status) {
        if (status !== '0') throw new Error(`Capture exited ${status}: ${await shell(`cat ${control}.log`)}`);
        if (lifecycle && !lifecycle.stop.aborted && !lifecycle.allowNaturalEnd) throw new Error('Capture ended before Flow finalization; coverage is incomplete');
        if (lifecycle?.allowNaturalEnd && !lifecycle.stop.aborted && Date.now() - Date.parse(startedAt) < (seconds - 1) * 1000) throw new Error('Capture segment ended prematurely');
        break;
      }
      if (lifecycle && !ready) {
        const started = await shell(`test -s ${control}.pid && test -e ${remote} && echo ready || true`);
        if (started === 'ready') { ready = true; lifecycle.ready(); }
      }
      if (lifecycle?.stop.aborted) break;
      if (Date.now() >= deadline) throw new Error('Capture deadline exceeded');
      await delay(200, undefined, signal ? { signal } : {});
    }
    signal?.throwIfAborted();
  } catch (error) { failure = error; }
  finally {
    try {
      // Wait for bootstrap to publish the PID even when cancellation races startup.
      const pid = await shell(`for n in 1 2 3 4 5; do if [ -s ${control}.pid ]; then cat ${control}.pid; break; fi; sleep 1; done`);
      if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('Capture PID unavailable; remote cleanup cannot be confirmed');
      const owned = () => probeOwnership(exec, pid, remote, 'capture-ownership', transportErrors);
      for (const number of [2, 15, 9]) {
        if (!await owned()) break;
        if (number !== 2) forced = true;
        // Re-check ownership inside the same shell immediately before signalling.
        await shell(`case "$(tr '\\000' ' ' < /proc/${pid}/cmdline 2>/dev/null)" in *${remote}*) kill -${number} ${pid};; esac`);
        for (let n = 0; n < 10 && await owned(); n++) await delay(100);
      }
      if (await owned()) throw new Error('Capture process remained alive after cleanup');
      // The supervisor publishes status after the capture exits; wait before removing controls.
      await shell(`for n in 1 2 3 4 5; do [ -f ${control}.status ] && break; sleep 1; done; test -f ${control}.status`);
      if (forced && !failure) failure = new Error('Capture required forced termination; artifact finalization is uncertain');
      // Preserve a remote artifact until a nonempty local transfer is verified.
      const presenceStarted = Date.now();
      if (await shell(`if [ -f ${remote} ]; then echo present; fi`) === 'present') {
        const pullStarted = Date.now();
        try {
          await exec(['pull', remote, path], 120000);
          const local = await stat(path);
          if (!local.isFile() || local.size < 1) throw new Error('Capture transfer produced no nonempty regular local artifact');
        } catch (error) {
          recordTransportError(transportErrors, 'capture-pull', 1, pullStarted, error);
          if (!failure) failure = error;
          throw new Error('Capture transfer unverified; remote artifact retained', { cause: error });
        }
      } else {
        const error = Object.assign(new Error('Capture artifact absent after process exit'), { code: 'ENOENT' });
        recordTransportError(transportErrors, 'capture-pull', 0, presenceStarted, error);
        if (!failure) failure = error;
        throw new Error('Capture transfer unverified; remote controls retained', { cause: error });
      }
      await shell(`rm -f ${remote} ${control}.pid ${control}.status ${control}.log`);
    } catch (error) { cleanupError = error; }
    if (!failure) {
      try { signal?.throwIfAborted(); }
      catch (error) { failure = error; }
    }
    try {
      await save({ status: failure || cleanupError ? 'failed' : 'passed', cancelled: signal?.aborted ?? false, cleaned: !cleanupError, finishedAt: new Date().toISOString(), ...(failure ? { error: String(failure) } : {}), ...(cleanupError ? { cleanupError: String(cleanupError) } : {}), ...(transportErrors.length ? { transportErrors } : {}) });
    } catch (evidenceError) {
      throw Object.assign(new AggregateError([failure, cleanupError, evidenceError].filter(Boolean), 'Capture cleanup or final evidence could not be verified'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
    }
  }
  if (cleanupError) throw Object.assign(new AggregateError([failure, cleanupError].filter(Boolean), 'Capture cleanup failed; see capture evidence'), { code: 'APPVANTA_RESTORATION_UNVERIFIED' });
  if (failure) throw failure;
  return { path, capturedAt: new Date().toISOString() };
}

/** Clean only capture processes whose persisted command line still owns the exact artifact. */
export async function recoverCaptures(adb: string, device: string, runDirectory: string): Promise<{ artifact: string; status: string }[]> {
  const directory = join(runDirectory, 'captures');
  let names: string[];
  try { names = (await readdir(directory)).filter(name => name.endsWith('.capture.json')); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const exec = async (args: string[], timeout = 20000) => (await promisify(execFile)(adb, ['-s', device, ...args], { encoding: 'utf8', timeout, windowsHide: true })).stdout.trim();
  const shell = (command: string) => exec(['shell', command]);
  const results: { artifact: string; status: string }[] = [];
  for (const file of names.sort()) {
    const evidencePath = join(directory, file);
    const record = parseRecoveryRecord(JSON.parse(await readFile(evidencePath, 'utf8')), device);
    if (record.cleaned && ['passed', 'failed', 'recovered'].includes(record.status)) {
      results.push({ artifact: record.artifact, status: 'already-clean' });
      continue;
    }
    const pid = await shell(`if [ -s ${record.control}.pid ]; then cat ${record.control}.pid; fi`);
    if (pid && !/^[1-9][0-9]*$/.test(pid)) throw new Error(`Invalid capture PID for ${record.artifact}`);
    const transportErrors: TransportError[] = [...(record.transportErrors ?? [])];
    const owned = async () => {
      if (!pid) return false;
      const previousErrors = transportErrors.length;
      let observed: boolean;
      try {
        observed = await probeOwnership(exec, pid, record.remote, 'recovery-ownership', transportErrors);
      }
      catch (error) {
        await writeFile(evidencePath, JSON.stringify({ ...record, status: 'failed', cleaned: false, transportErrors,
          cleanupError: 'Capture ownership probe failed; remote artifact retained', finishedAt: new Date().toISOString() }, null, 2));
        throw error;
      }
      if (transportErrors.length !== previousErrors) await writeFile(evidencePath, JSON.stringify({ ...record, cleaned: false, transportErrors }, null, 2));
      return observed;
    };
    if (pid && await owned()) {
      for (const signal of [2, 15, 9]) {
        if (!await owned()) break;
        await shell(`case "$(tr '\\000' ' ' < /proc/${pid}/cmdline 2>/dev/null)" in *${record.remote}*) kill -${signal} ${pid};; esac`);
        for (let n = 0; n < 20 && await owned(); n++) await delay(100);
      }
      if (await owned()) throw new Error(`Capture process remained alive: ${record.artifact}`);
    }
    const recoveredDirectory = join(directory, 'recovered');
    await mkdir(recoveredDirectory, { recursive: true });
    const preserved: { path: string; bytes: number }[] = [];
    for (const [remote, name] of [[record.remote, record.artifact], [`${record.control}.log`, `${record.artifact}.log`]]) {
      const local = join(recoveredDirectory, name!);
      const presenceStarted = Date.now();
      if ((await shell(`if [ -f ${remote} ]; then echo present; fi`)) === 'present') {
        const pullStarted = Date.now();
        try {
          await exec(['pull', remote!, local], 60000);
          const localArtifact = await stat(local);
          if (!localArtifact.isFile() || (remote === record.remote && localArtifact.size < 1)) throw new Error(`Recovered capture transfer unverified: ${record.artifact}`);
        } catch (error) {
          recordTransportError(transportErrors, 'recovery-pull', 1, pullStarted, error);
          await writeFile(evidencePath, JSON.stringify({ ...record, status: 'failed', cleaned: false, transportErrors,
            cleanupError: 'Recovered capture transfer unverified; remote artifact retained', finishedAt: new Date().toISOString() }, null, 2));
          throw error;
        }
      } else if (remote === record.remote) {
        const error = Object.assign(new Error(`Required capture artifact absent: ${record.artifact}`), { code: 'ENOENT' });
        recordTransportError(transportErrors, 'recovery-pull', 0, presenceStarted, error);
        await writeFile(evidencePath, JSON.stringify({ ...record, status: 'failed', cleaned: false, transportErrors,
          cleanupError: 'Required capture artifact absent; remote controls retained', finishedAt: new Date().toISOString() }, null, 2));
        throw error;
      }
      try { preserved.push({ path: `recovered/${name}`, bytes: (await stat(local)).size }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const recovered = { ...record, status: 'recovered', preserved, transportErrors, artifactValidity: 'unverified', finishedAt: new Date().toISOString(), error: record.error ?? 'Recovered after owning host exited before capture finalization' };
    await writeFile(evidencePath, JSON.stringify({ ...recovered, cleaned: false }, null, 2));
    await shell(`rm -f ${record.remote} ${record.control}.pid ${record.control}.status ${record.control}.log`);
    await writeFile(evidencePath, JSON.stringify({ ...recovered, cleaned: true }, null, 2));
    results.push({ artifact: record.artifact, status: 'recovered' });
  }
  return results;
}
