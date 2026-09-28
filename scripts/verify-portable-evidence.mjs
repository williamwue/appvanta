import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { stageEvidence, verifyEvidence } from '../packages/core/dist/archive.mjs';
const source = process.argv[2]; assert(source, 'Specify run directory');
const root = resolve('.appvanta/runs', `portable-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const staged = join(root, 'staged'), moved = join(root, 'moved');
await stageEvidence(source, staged);
await rename(staged, moved);
const verified = await verifyEvidence(moved);
const manifest = JSON.parse(await readFile(join(moved, 'manifest.json'), 'utf8'));
let links = 0;
for (const file of manifest.files.filter(file => file.path.endsWith('.html'))) {
  const html = await readFile(join(moved, file.path), 'utf8');
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    assert(!/^(?:[a-z]+:|\/)/i.test(match[1]), 'Non-relative viewer link');
    const destination = resolve(moved, dirname(file.path), decodeURIComponent(match[1]));
    assert(!relative(moved, destination).startsWith('..'), 'Link escapes export');
    await access(destination); links++;
  }
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', source: resolve(source), moved, verified, links }, null, 2));
console.log(JSON.stringify({ status: 'passed', root, viewer: join(moved, 'index.html'), links }));
