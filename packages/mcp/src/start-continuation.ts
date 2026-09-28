import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '@appvanta/core';
import { requestContinuationCancellation } from './continuation-cancellation.js';

export async function startContinuation(store: TaskStore, taskId: string, leaseToken: string, checkpoint: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await store.get(taskId);
  signal?.throwIfAborted();
  const id = randomUUID(), root = resolve('.appvanta/continuations', id);
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, 'request.json'), JSON.stringify({ id, taskId, leaseToken, checkpoint }), { flag: 'wx' });
  if (signal?.aborted) {
    await requestContinuationCancellation(root);
    throw new Error(`Continuation cancelled before worker launch; inspect ${root}`);
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./continuation-worker.js', import.meta.url)), id], {
    cwd: process.cwd(), windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env, APPVANTA_PROJECT_ROOT: process.cwd() },
  });
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; }); child.unref();
  const read = async (name: string) => {
    try { return JSON.parse(await readFile(resolve(root, `${name}.json`), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await requestContinuationCancellation(root);
      throw new Error(`Continuation startup cancellation recorded; cleanup may still be running. Inspect ${root}`);
    }
    if (spawnError) throw spawnError;
    const ready = await read('ready');
    if (ready) {
      const task = await store.get(ready.taskId);
      if (signal?.aborted) {
        await requestContinuationCancellation(root);
        throw new Error(`Continuation startup cancellation recorded; inspect ${root}`);
      }
      if (ready.requestId !== id || ready.sourceTaskId !== taskId || ready.pid !== child.pid || ready.session !== id
        || task.owner.pid !== child.pid || task.owner.session !== id) throw new Error('Continuation readiness does not match worker ownership');
      if (!task.runDirectory) throw new Error('Continuation ready without a bound run');
      const binding = JSON.parse(await readFile(resolve(task.runDirectory, 'device-lease.json'), 'utf8'));
      if (binding.pid !== child.pid || binding.deviceId !== task.deviceId || binding.runDirectory !== task.runDirectory) {
        throw new Error('Continuation readiness does not match the run binding');
      }
      return { requestId: id, sourceTaskId: taskId, taskId: task.id, workerPid: child.pid, status: task.status };
    }
    const failure = await read('error');
    if (failure) throw new Error(`Continuation request ${id}: ${failure.error}`);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Continuation worker exited before readiness; inspect ${root}`);
    await delay(50);
  }
  throw new Error(`Continuation readiness timeout; worker may still be recovering. Inspect ${root} before retrying`);
}
