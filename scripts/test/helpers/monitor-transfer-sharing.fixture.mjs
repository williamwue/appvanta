import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const persistent = process.argv[2] === 'persistent';
let target, reader, exited, failures = 0;
const events = [];
const recordEvent = (phase, details = {}) => {
  const event = { phase, at: Date.now(), ...details };
  events.push(event);
  console.log(JSON.stringify(event));
};
recordEvent('fixture-started');
mock.module('node:fs/promises', { namedExports: { ...fs,
  rename: async (from, to) => {
    try { return await fs.rename(from, to); }
    catch (error) {
      if (!target || !basename(from).startsWith('transfer-') || await fs.realpath(to) !== target) throw error;
      assert.equal(error.code, 'EPERM', 'Require a real OS sharing violation');
      failures++;
      if (failures === 1) recordEvent('native-rename-denied');
      if (!persistent && failures === 1) {
        reader.stdin.end('release\n');
        assert.deepEqual(await exited, [0, null]);
        recordEvent('holder-exited');
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
  reader = spawn(process.env.APPVANTA_TEST_PYTHON ?? 'python', ['-u', fileURLToPath(new URL('./windows-share-holder.py', import.meta.url))], { env: { ...process.env, APPVANTA_RECORD: target }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  recordEvent('holder-spawned');
  exited = once(reader, 'exit');
  let stderr = ''; reader.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: reader.stdout });
  const ready = new Promise((resolveReady, rejectReady) => {
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        assert.equal(event.pid, reader.pid);
        recordEvent(`holder-${event.phase}`, { holderAt: event.at, holderPid: event.pid });
        if (event.phase === 'lock-acquired') resolveReady();
      } catch (error) { rejectReady(error); }
    });
  });
  let readyTimer;
  await Promise.race([ready, exited.then(() => { throw new Error(`Reader exited before locking: ${stderr}`); }),
    new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error(`Holder ready handshake exceeded 10 seconds: ${stderr}`)), 10000); }),
  ]).finally(() => clearTimeout(readyTimer));
  recordEvent('holder-locked');
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
  recordEvent(persistent ? 'bounded-refusal' : 'transfer-passed');
  console.log(JSON.stringify({ mode: persistent ? 'persistent' : 'transient', nativeFailures: failures, events }));
} finally {
  recordEvent('cleanup-started');
  if (reader && reader.exitCode === null && reader.signalCode === null) {
    reader.stdin.end('release\n');
    await Promise.race([exited, delay(2000, undefined, { ref: false })]);
    if (reader.exitCode === null && reader.signalCode === null) {
      recordEvent('holder-termination-requested'); reader.kill();
      await Promise.race([exited, delay(2000, undefined, { ref: false })]);
      assert(reader.exitCode !== null || reader.signalCode !== null, 'Holder did not terminate after fixture cleanup');
    }
  }
  recordEvent('holder-cleaned');
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
