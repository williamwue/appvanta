import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(repository, 'packages/android/dist/runtime');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const name of ['analyze-perfetto.py', 'capture-network.py', 'network-addon.py', 'network_finalization.py', 'proxy_recovery.py']) {
  await copyFile(join(repository, 'scripts', name), join(destination, name));
}
for (const name of ['core', 'android', 'cli', 'mcp']) {
  const dist = join(repository, 'packages', name, 'dist');
  await mkdir(dist, { recursive: true });
  await copyFile(join(repository, 'LICENSE'), join(dist, 'LICENSE'));
  await copyFile(join(repository, 'THIRD_PARTY_NOTICES.md'), join(dist, 'THIRD_PARTY_NOTICES.md'));
}
