import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetApplicationData } from '../dist/index.js';

test('application reset persists intent before clear and reports partial failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-reset-'));
  const calls = [];
  try {
    await assert.rejects(resetApplicationData(['app.one', 'app.two'], 'device-1', root, undefined, {
      runAdb: async args => {
        calls.push(args);
        const packageName = args.at(-1);
        if (args.includes('path')) return { stdout: `package:/data/app/${packageName}/base.apk\n`, stderr: '' };
        if (packageName === 'app.two') return { stdout: 'Failed\n', stderr: '' };
        return { stdout: 'Success\n', stderr: '' };
      },
    }), /did not succeed/);
    assert.equal(calls.filter(args => args.includes('clear')).length, 2);
    const record = JSON.parse(await readFile(join(root, 'fixtures/app-data-reset.json'), 'utf8'));
    assert.equal(record.restorable, false);
    assert.deepEqual(record.entries.map(entry => entry.status), ['cleared', 'failed']);
    const audit = (await readFile(join(root, 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(audit.map(event => event.outcome), ['started', 'passed', 'started', 'failed']);
    await assert.rejects(resetApplicationData(['bad;package'], 'device-1', root, undefined, { runAdb: async () => { throw new Error('must not run'); } }), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
