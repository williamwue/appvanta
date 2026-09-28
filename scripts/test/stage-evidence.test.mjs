import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stageEvidence } from '../stage-evidence.mjs';

test('archives evidence with hashes, excluding CA directories, private keys and external links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-export-'));
  try {
    const source = join(root, 'runs');
    await mkdir(join(source, 'run/network/ca'), { recursive: true });
    await writeFile(join(source, 'run/report.md'), '# failed run');
    await writeFile(join(source, 'run/network/requests.jsonl'), '{"statusCode":200}\n');
    await writeFile(join(source, 'run/network/ca/private.txt'), 'private');
    await writeFile(join(source, 'run/disguised.log'), '-----BEGIN PRIVATE KEY-----\nsecret');
    await writeFile(join(source, 'run/secret.p12'), 'binary key');
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside/leak.txt'), 'external');
    await symlink(join(root, 'outside'), join(source, 'link'), 'junction');
    await symlink(join(root, 'missing-target'), join(source, 'broken-link'), 'junction');
    const result = await stageEvidence(source, join(root, 'export'));
    assert.equal(result.files.length, 4);
    assert.equal(result.excluded.length, 5);
    const cli = JSON.parse(execFileSync(process.execPath, ['packages/cli/dist/index.js', 'export', source, join(root, 'cli')], { encoding: 'utf8' }));
    const cliManifest = JSON.parse(await readFile(join(cli.exported, 'manifest.json'), 'utf8'));
    assert.deepEqual(cliManifest, result);
    for (const file of cliManifest.files) {
      const bytes = await readFile(join(cli.exported, file.path));
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    }
    assert.throws(() => execFileSync(process.execPath, ['packages/cli/dist/index.js', 'export', source, join(root, 'cli')], { stdio: 'pipe' }));
    assert.deepEqual(JSON.parse(await readFile(join(cli.exported, 'manifest.json'), 'utf8')), cliManifest);
    await symlink(source, join(root, 'alias'), 'junction');
    await assert.rejects(stageEvidence(source, join(root, 'alias/nested')), /outside source/);
    await assert.rejects(stageEvidence(join(root, 'missing'), join(root, 'missing-export')), /ENOENT/);
    const missing = await stageEvidence(join(root, 'missing'), join(root, 'empty-export'), { allowMissing: true });
    assert.equal(missing.missingSource, true);
    await assert.rejects(stageEvidence(join(root, 'missing'), join(root, 'empty-export'), { allowMissing: true }));
    const repeated = await stageEvidence(cli.exported, join(root, 'reexport'));
    assert.deepEqual(repeated.files, result.files);
    assert.ok(repeated.excluded.some(item => item.path === 'manifest.json'));
    assert.ok(result.files.every(file => file.sha256.length === 64));
    assert.equal(await readFile(join(root, 'export/run/report.md'), 'utf8'), '# failed run');
    await assert.rejects(stageEvidence(source, join(source, 'nested')), /outside source/);
    await assert.rejects(stageEvidence(source, join(root, 'export')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
