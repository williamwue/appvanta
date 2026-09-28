#!/usr/bin/env node
import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore, terminalTask, validateWebhookSigningSecret } from '@appvanta/core';
import { runPersistedTask } from './async-task.js';

if (process.env.APPVANTA_PROJECT_ROOT) {
  if (!isAbsolute(process.env.APPVANTA_PROJECT_ROOT)) throw new Error('APPVANTA_PROJECT_ROOT must be an absolute path');
  process.chdir(process.env.APPVANTA_PROJECT_ROOT);
}
const [taskId, workerSession] = process.argv.slice(2);
if (!taskId || !/^task-[a-f0-9-]{36}$/.test(taskId) || !workerSession) throw new Error('Usage: task-worker <task-id> <worker-session>');
const store = new TaskStore(resolve('.appvanta/tasks'), workerSession), root = resolve(store.directory, taskId);
const origins = (process.env.APPVANTA_WEBHOOK_ALLOW_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const signingSecret = process.env.APPVANTA_WEBHOOK_SIGNING_SECRET ? validateWebhookSigningSecret(process.env.APPVANTA_WEBHOOK_SIGNING_SECRET) : undefined;

try {
  const deadline = Date.now() + 10000;
  while (true) {
    const task = await store.get(taskId);
    if (task.owner.pid === process.pid && task.owner.session === workerSession) break;
    if (Date.now() >= deadline) throw new Error('Task ownership transfer deadline exceeded');
    await delay(25);
  }
  const readyPath = resolve(root, 'worker.ready.json'), readyTempPath = resolve(root, `worker.ready.${workerSession}.tmp`);
  await writeFile(readyTempPath, JSON.stringify({ version: 1, taskId, pid: process.pid, session: workerSession, readyAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
  await rename(readyTempPath, readyPath);
  await runPersistedTask(taskId, store, origins, signingSecret);
} catch (error) {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  await writeFile(resolve(root, 'worker-error.txt'), message).catch(() => {});
  try {
    const task = await store.get(taskId);
    if (task.owner.pid === process.pid && task.owner.session === workerSession && !terminalTask(task.status)) {
      task.status = 'failed'; task.finishedAt = new Date().toISOString(); task.error = String(error); await store.save(task);
    }
  } catch {}
  process.exitCode = 1;
}
