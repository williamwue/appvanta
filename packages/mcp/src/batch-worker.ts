#!/usr/bin/env node
import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BatchStore, terminalBatch } from '@appvanta/core';
import { runPersistedBatch } from './async-batch.js';

if (process.env.APPVANTA_PROJECT_ROOT) {
  if (!isAbsolute(process.env.APPVANTA_PROJECT_ROOT)) throw new Error('APPVANTA_PROJECT_ROOT must be an absolute path');
  process.chdir(process.env.APPVANTA_PROJECT_ROOT);
}
const [batchId, workerSession] = process.argv.slice(2);
if (!batchId || !/^batch-task-[a-f0-9-]{36}$/.test(batchId) || !workerSession) throw new Error('Usage: batch-worker <batch-id> <worker-session>');
const store = new BatchStore(resolve('.appvanta/batches'), workerSession), root = resolve(store.directory, batchId);

try {
  const deadline = Date.now() + 10000;
  while (true) {
    const batch = await store.get(batchId);
    if (batch.owner.pid === process.pid && batch.owner.session === workerSession) break;
    if (Date.now() >= deadline) throw new Error('Batch ownership transfer deadline exceeded');
    await delay(25);
  }
  const readyPath = resolve(root, 'worker.ready.json'), readyTempPath = resolve(root, `worker.ready.${workerSession}.tmp`);
  await writeFile(readyTempPath, JSON.stringify({ version: 1, batchId, pid: process.pid, session: workerSession, readyAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
  await rename(readyTempPath, readyPath);
  await runPersistedBatch(batchId, store);
} catch (error) {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  await writeFile(resolve(root, 'worker-error.txt'), message).catch(() => {});
  try {
    const batch = await store.get(batchId);
    if (batch.owner.pid === process.pid && batch.owner.session === workerSession && !terminalBatch(batch.status)) {
      batch.status = 'failed'; batch.finishedAt = new Date().toISOString(); batch.error = String(error); await store.save(batch);
    }
  } catch {}
  process.exitCode = 1;
}
