import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageEvidence, verifyEvidence } from '../../packages/core/dist/archive.mjs';
test('offline views resolve historical absolute paths without modifying evidence and reject tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-portable-'));
  try {
    const source = join(root, 'source'); await mkdir(join(source, 'artifacts'), { recursive: true });
    await writeFile(join(source, 'artifacts/image.png'), 'image');
    const report = JSON.stringify({ path: 'C:\\old-host\\run\\artifacts\\image.png', message: '<script>alert(1)</script>', external: 'javascript:alert(1)' });
    await writeFile(join(source, 'report.json'), report);
    const steps = report + '\n<script>malformed line</script>\n' + report + '\n';
    await writeFile(join(source, 'steps.jsonl'), steps);
    await stageEvidence(source, join(root, 'export'));
    await rename(join(root, 'export'), join(root, 'moved'));
    await rm(source, { recursive: true, force: true });
    const output = join(root, 'moved');
    assert.equal((await verifyEvidence(output)).status, 'passed');
    assert.equal(await readFile(join(output, 'report.json'), 'utf8'), report);
    const html = await readFile(join(output, '.appvanta-view/0.html'), 'utf8');
    assert(html.includes('href="../artifacts/image.png"'));
    assert(!html.includes('<script>'));
    assert(!html.includes('href="javascript:'));
    assert(!html.includes('C:\\old-host'));
    const stepView = await readFile(join(output, '.appvanta-view/1.html'), 'utf8');
    assert.equal((stepView.match(/href="\.\.\/artifacts\/image.png"/g) ?? []).length, 2);
    assert(!stepView.includes('<script>'));
    assert(stepView.includes('&lt;script&gt;malformed line'));
    assert.equal(await readFile(join(output, 'steps.jsonl'), 'utf8'), steps);
    await writeFile(join(output, '.appvanta-view/0.html'), 'tampered');
    await assert.rejects(verifyEvidence(output), /integrity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('export verification rejects missing, extra, duplicate and escaping entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-integrity-'));
  try {
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'report.md'), '# report');
    const output = join(root, 'export');
    const manifest = await stageEvidence(source, output);
    await writeFile(join(output, 'extra.log'), 'unexpected');
    await assert.rejects(verifyEvidence(output), /Unmanifested/);
    await rm(join(output, 'extra.log'));
    await rename(join(output, 'report.md'), join(root, 'saved.md'));
    await assert.rejects(verifyEvidence(output), /ENOENT/);
    await rename(join(root, 'saved.md'), join(output, 'report.md'));
    for (const files of [
      [...manifest.files, manifest.files[0]],
      [{ ...manifest.files[0], path: '../outside.md' }],
    ]) {
      await writeFile(join(output, 'manifest.json'), JSON.stringify({ ...manifest, files }));
      await assert.rejects(verifyEvidence(output), /Unsafe or duplicate/);
    }
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest));
    assert.equal((await verifyEvidence(output)).status, 'passed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
