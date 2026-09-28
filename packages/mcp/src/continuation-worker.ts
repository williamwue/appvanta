import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { TaskStore } from '@appvanta/core';
import { continueAndroidTask } from '@appvanta/android';
import { watchContinuationCancellation } from './continuation-cancellation.js';

const project = process.env.APPVANTA_PROJECT_ROOT;
if (!project || !isAbsolute(project)) throw new Error('Absolute project root required');
process.chdir(project);
const id = process.argv[2];
if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid continuation request id');
const root = resolve('.appvanta/continuations', id);
const save = async (name: string, record: unknown) => {
  const temporary = resolve(root, `${name}.tmp`);
  await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx' });
  await rename(temporary, resolve(root, `${name}.json`));
};
const cancellation = await watchContinuationCancellation(root);
try {
  cancellation.signal.throwIfAborted();
  const request = JSON.parse(await readFile(resolve(root, 'request.json'), 'utf8'));
  if (request.id !== id) throw new Error('Continuation request identity mismatch');
  const store = new TaskStore(resolve('.appvanta/tasks'), id);
  const result = await continueAndroidTask(store, request.taskId, request.leaseToken, request.checkpoint, cancellation.signal, async taskId => {
    await cancellation.check();
    cancellation.signal.throwIfAborted();
    await save('ready', { requestId: id, sourceTaskId: request.taskId, taskId, pid: process.pid, session: id });
  });
  await save('result', result);
} catch (error) {
  await save('error', { requestId: id, pid: process.pid, error: String(error) });
  process.exitCode = 1;
} finally {
  await cancellation.stop();
}
