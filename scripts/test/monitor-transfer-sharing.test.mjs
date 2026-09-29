import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorStore } from '../../packages/core/dist/index.js';

for (const persistent of [false, true]) test(`monitor transfer ${persistent ? 'fails without changing ownership under persistent' : 'survives temporary'} Windows delete-sharing denial`, { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-monitor-sharing-'));
  const store = new MonitorStore(root);
  let reader;
  try {
    const record = await store.create('offline-device', 500, 1000);
    const path = join(record.rootDirectory, 'monitor.json');
    const script = `
$stream = [System.IO.File]::Open($env:APPVANTA_RECORD, 'Open', 'Read', 'ReadWrite')
try {
  [Console]::WriteLine('locked')
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($env:APPVANTA_PERSISTENT -ne '1' -and [System.IO.Directory]::GetFiles([System.IO.Path]::GetDirectoryName($env:APPVANTA_RECORD), 'transfer-*.tmp').Length -gt 0) { Start-Sleep -Milliseconds 150; break }
    Start-Sleep -Milliseconds 10
  }
} finally { $stream.Dispose() }
`;
    reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, APPVANTA_RECORD: path, APPVANTA_PERSISTENT: persistent ? '1' : '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(reader, 'exit');
    const [output] = await Promise.race([once(reader.stdout, 'data'), exited.then(() => { throw new Error('Reader exited before locking'); })]);
    assert.match(output.toString(), /locked/);
    const session = randomUUID();
    if (persistent) {
      await assert.rejects(store.transferQueued(record, process.pid, session), { code: 'EPERM' });
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
      return;
    }
    const transferred = await store.transferQueued(record, process.pid, session);
    assert.equal(transferred.owner.session, session);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).owner.session, session);
    assert.deepEqual(await exited, [0, null]);
  } finally {
    if (reader && reader.exitCode === null && reader.signalCode === null) { const exited = once(reader, 'exit'); reader.kill(); await exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
