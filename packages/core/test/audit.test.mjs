import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../dist/index.js';

test('appends structured audit events as JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-audit-'));
  const path = join(root, 'audit.jsonl');
  await new AuditLog(path).append({ timestamp: new Date().toISOString(), actor: 'test', action: 'step', outcome: 'passed' });
  const line = (await readFile(path, 'utf8')).trim();
  assert.equal(JSON.parse(line).action, 'step');
});
