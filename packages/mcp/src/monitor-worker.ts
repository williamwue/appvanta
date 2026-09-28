#!/usr/bin/env node
import { rename, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MonitorStore, terminalMonitor } from '@appvanta/core';
import { runPersistedMonitor } from './async-monitor.js';

if (process.env.APPVANTA_PROJECT_ROOT) {
  if (!isAbsolute(process.env.APPVANTA_PROJECT_ROOT)) throw new Error('APPVANTA_PROJECT_ROOT must be an absolute path');
  process.chdir(process.env.APPVANTA_PROJECT_ROOT);
}
const [monitorId, workerSession] = process.argv.slice(2);
if (!monitorId || !/^monitor-[a-f0-9-]{36}$/.test(monitorId) || !workerSession) throw new Error('Usage: monitor-worker <monitor-id> <worker-session>');
const store = new MonitorStore(resolve('.appvanta/monitors'), workerSession), root = resolve(store.directory, monitorId);

try {
  const deadline = Date.now() + 10000;
  while (true) {
    const monitor = await store.get(monitorId);
    if (monitor.owner.pid === process.pid && monitor.owner.session === workerSession) break;
    if (Date.now() >= deadline) throw new Error('Monitor ownership transfer deadline exceeded');
    await delay(25);
  }
  const readyPath = resolve(root, 'worker.ready.json'), readyTempPath = resolve(root, `worker.ready.${workerSession}.tmp`);
  await writeFile(readyTempPath, JSON.stringify({ version: 1, monitorId, pid: process.pid, session: workerSession, readyAt: new Date().toISOString() }, null, 2), { flag: 'wx' }); await rename(readyTempPath, readyPath);
  await runPersistedMonitor(monitorId, store);
} catch (error) {
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  await writeFile(resolve(root, 'worker-error.txt'), message).catch(() => {});
  try {
    const monitor = await store.get(monitorId);
    if (monitor.owner.pid === process.pid && monitor.owner.session === workerSession && !terminalMonitor(monitor.status)) {
      monitor.status = 'failed'; monitor.finishedAt = new Date().toISOString(); monitor.error = String(error); await store.save(monitor);
    }
  } catch {}
  process.exitCode = 1;
}
