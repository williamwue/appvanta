import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { buildArchiveViewer } from './archive-viewer.mjs';

const allowedExtensions = new Set(['.json', '.jsonl', '.md', '.txt', '.log', '.xml', '.png', '.jpg', '.jpeg', '.mp4', '.perfetto-trace', '.trace']);
const forbiddenDirectory = /^(ca|network-ca|proxy-venv|node_modules|\.git|\.venv|\.appvanta-view)$/i;
const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/** Build a new, bounded artifact tree. Never overwrite old exports or follow links. */
export async function stageEvidence(source, destination, { allowMissing = false } = {}) {
  const root = resolve(source);
  const output = resolve(destination);
  const outside = (path) => path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path);
  const inside = relative(root, output);
  if (inside === '' || !outside(inside)) throw new Error('Destination must be outside source');
  const files = [];
  const excluded = [];
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Evidence source must be a real directory');
  } catch (error) {
    if (error.code !== 'ENOENT' || !allowMissing) throw error;
    await mkdir(output, { recursive: false });
    const manifest = { version: 1, files, excluded, missingSource: true };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return manifest;
  }
  const canonical = await realpath(root);
  const canonicalOutput = join(await realpath(resolve(output, '..')), output.split(/[\\/]/).at(-1));
  if (!outside(relative(canonical, canonicalOutput))) throw new Error('Destination must be outside source');
  await mkdir(output, { recursive: false });
  // Write the manifest only after every file succeeds. Keep only one file's
  // contents in memory so a large collection of traces does not exhaust RAM.
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      const name = relative(root, path).replaceAll('\\', '/');
      if (item.isSymbolicLink()) {
        excluded.push({ path: name, reason: 'link or outside source' });
        continue;
      }
      const resolved = relative(canonical, await realpath(path));
      if (item.isSymbolicLink() || outside(resolved)) {
        excluded.push({ path: name, reason: 'link or outside source' });
      } else if (item.isDirectory()) {
        if (forbiddenDirectory.test(item.name)) excluded.push({ path: name, reason: 'tool or certificate directory' });
        else await walk(path);
      } else if (item.isFile()) {
        if (name === 'manifest.json') { excluded.push({ path: name, reason: 'replaced by export manifest' }); continue; }
        if (!allowedExtensions.has(extname(item.name).toLowerCase()) || item.name.startsWith('.')) {
          excluded.push({ path: name, reason: 'not an evidence file type' });
          continue;
        }
        const data = await readFile(path);
        if (privateKey.test(data.toString('utf8'))) {
          excluded.push({ path: name, reason: 'private key material' });
          continue;
        }
        const outputPath = join(output, name);
        await mkdir(resolve(outputPath, '..'), { recursive: true });
        await writeFile(outputPath, data, { flag: 'wx' });
        files.push({ path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      }
    }
  }
  await walk(root);
  await buildArchiveViewer(output, [...files], async (name, html) => {
    const data = Buffer.from(html, 'utf8');
    await mkdir(resolve(output, name, '..'), { recursive: true });
    await writeFile(join(output, name), data, { flag: 'wx' });
    files.push({ path: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  });
  const manifest = { version: 1, files, excluded, missingSource: false };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

export async function verifyEvidence(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.missingSource) throw new Error('Invalid or incomplete export manifest');
  const canonical = await realpath(root);
  const expected = new Set(['manifest.json']);
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.includes(':') || file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '.' || part === '..') || expected.has(file.path)) throw new Error('Unsafe or duplicate manifest path');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid manifest file metadata');
    expected.add(file.path);
    const path = join(root, file.path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular evidence file: ${file.path}`);
    const resolved = relative(canonical, await realpath(path));
    if (resolved.startsWith('..') || isAbsolute(resolved)) throw new Error('Evidence path escapes archive');
    const data = await readFile(path);
    if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`Evidence integrity mismatch: ${file.path}`);
  }
  const walk = async directory => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('Archive contains a link');
      if (item.isDirectory()) await walk(path);
      else if (!expected.has(relative(root, path).replaceAll('\\', '/'))) throw new Error(`Unmanifested evidence: ${item.name}`);
    }
  };
  await walk(root);
  return { status: 'passed', files: manifest.files.length, directory: root };
}

