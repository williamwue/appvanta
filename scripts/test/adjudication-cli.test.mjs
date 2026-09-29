import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));
const commands = ['adjudicate-task', 'prepare-adjudicated-task', 'reserve-adjudicated-task', 'continue-adjudicated-task'];
test('adjudication CLI rejects invalid requests without creating task or lease state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-adjudication-cli-'));
  const run = args => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, APPVANTA_LOCK_DIRECTORY: join(root, 'locks') },
  });
  try {
    const help = run([]);
    assert.equal(help.status, 0, help.stderr);
    for (const command of commands) {
      assert.ok(help.stdout.includes(command));
      const missing = run([command]);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Usage:/);
      await writeFile(join(root, 'request.json'), 'null');
      const invalid = run([command, 'task-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'request.json']);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /Request must be a JSON object/);
    }
    const preview = run(['preview-uncertain-task', 'invalid']);
    assert.equal(preview.status, 1);
    assert.deepEqual(await readdir(root), ['request.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
