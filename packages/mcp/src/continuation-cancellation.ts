import { access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function requestContinuationCancellation(root: string) {
  await writeFile(resolve(root, 'cancel.requested'), '', { flag: 'a' });
}

export async function watchContinuationCancellation(root: string) {
  const controller = new AbortController();
  const check = async () => {
    try {
      await access(resolve(root, 'cancel.requested'));
      controller.abort(new Error('Continuation startup cancellation requested'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') controller.abort(error);
    }
  };
  await check();
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!pending) pending = check().finally(() => { pending = undefined; });
  }, 50);
  return { signal: controller.signal, check, stop: async () => { clearInterval(timer); await pending; } };
}
