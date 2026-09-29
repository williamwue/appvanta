import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const persistent = process.argv[2] === 'persistent';
let target, reader, exited, failures = 0;
const events = [];
mock.module('node:fs/promises', { namedExports: { ...fs,
  rename: async (from, to) => {
    try { return await fs.rename(from, to); }
    catch (error) {
      if (!target || !basename(from).startsWith('transfer-') || await fs.realpath(to) !== target) throw error;
      assert.equal(error.code, 'EPERM', 'Require a real OS sharing violation');
      failures++;
      if (failures === 1) events.push({ phase: 'native-rename-denied', at: Date.now() });
      if (!persistent && failures === 1) {
        reader.stdin.end('release\n');
        assert.deepEqual(await exited, [0, null]);
        events.push({ phase: 'holder-exited', at: Date.now() });
      }
      // Propagate the actual OS error; only the production retry can publish.
      throw error;
    }
  },
} });
const { MonitorStore } = await import('../../../packages/core/dist/index.js');
const root = await fs.mkdtemp(join(tmpdir(), 'appvanta-monitor-sharing-'));
try {
  const store = new MonitorStore(root);
  const record = await store.create('offline-device', 500, 1000);
  target = await fs.realpath(join(record.rootDirectory, 'monitor.json'));
  const before = await fs.readFile(target);
  const script = `
$stream = [System.IO.File]::Open($env:APPVANTA_RECORD, 'Open', 'Read', 'ReadWrite')
try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null }
finally { $stream.Dispose(); [Console]::WriteLine('released') }
`;
  reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, APPVANTA_RECORD: target }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  exited = once(reader, 'exit');
  let stderr = ''; reader.stderr.on('data', chunk => { stderr += chunk; });
  const [output] = await Promise.race([once(reader.stdout, 'data', { signal: AbortSignal.timeout(10000) }), exited.then(() => { throw new Error(`Reader exited before locking: ${stderr}`); })]);
  assert.match(output.toString(), /locked/);
  events.push({ phase: 'holder-locked', at: Date.now() });
  const session = randomUUID();
  if (persistent) {
    await assert.rejects(store.transferQueued(record, process.pid, session), { code: 'EPERM' });
    assert.equal(failures, 40);
    assert.equal(reader.exitCode, null);
    assert.deepEqual(await fs.readFile(target), before);
  } else {
    const transferred = await store.transferQueued(record, process.pid, session);
    assert.equal(failures, 1);
    assert.equal(transferred.owner.session, session);
    assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).owner.session, session);
  }
  events.push({ phase: persistent ? 'bounded-refusal' : 'transfer-passed', at: Date.now() });
  console.log(JSON.stringify({ mode: persistent ? 'persistent' : 'transient', nativeFailures: failures, events }));
} finally {
  if (reader && reader.exitCode === null && reader.signalCode === null) { reader.stdin.end('release\n'); await exited; }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
