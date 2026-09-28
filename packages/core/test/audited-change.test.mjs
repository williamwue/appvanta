import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, auditedStateChange } from '../dist/index.js';

test('audited state changes retain before/after values and failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-audit-change-'));
  const path = join(root, 'audit.jsonl');
  const log = new AuditLog(path);
  let state = 'deny';
  try {
    assert.deepEqual(await auditedStateChange({ log, actor: 'test', action: 'set', target: 'device/pkg/op', read: async () => state, apply: async () => { state = 'allow'; } }), { before: 'deny', after: 'allow' });
    await assert.rejects(auditedStateChange({ log, actor: 'test', action: 'set', target: 'device/pkg/op', read: async () => state, apply: async () => { throw new Error('rejected'); } }), /rejected/);
    const events = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(event => event.outcome), ['started', 'passed', 'started', 'failed']);
    assert.deepEqual(events[1].metadata, { before: 'deny', after: 'allow' });
    assert.equal(events[3].metadata.before, 'allow');
  } finally { await rm(root, { recursive: true, force: true }); }
});
