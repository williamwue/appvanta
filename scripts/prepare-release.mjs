import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, '.appvanta', 'releases', `0.1.0-${Date.now()}`));
const run = (file, args, options = {}) => promisify(execFile)(file, args, { cwd: root, encoding: 'utf8', timeout: 180000, windowsHide: true, ...options });
const npm = (args, options = {}) => process.env.npm_execpath ? run(process.execPath, [process.env.npm_execpath, ...args], options) : run('npm', args, options);

const status = (await run('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
assert.equal(status, '', 'Tracked worktree changes must be committed before preparing a release');
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
await npm(['run', 'check:history-policy']);
await npm(['run', 'build']);
await npm(['test']);
await npm(['run', 'verify:release-packages']);

const staging = join(output, 'packages'); await mkdir(staging);
const packages = [];
for (const name of ['core', 'android', 'cli', 'mcp']) {
  const result = JSON.parse((await npm(['pack', '--workspace', `@appvanta/${name}`, '--pack-destination', staging, '--json'])).stdout)[0];
  const path = join(staging, result.filename), bytes = await readFile(path);
  packages.push({ name: `@appvanta/${name}`, version: result.version, file: `packages/${result.filename}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: result.integrity });
}
const [commit, nodeVersion, npmVersion] = await Promise.all([
  run('git', ['rev-parse', 'HEAD']).then(value => value.stdout.trim()),
  Promise.resolve(process.version),
  npm(['--version']).then(value => value.stdout.trim()),
]);
const manifest = { version: 1, productVersion: packages[0].version, commit, createdAt: new Date().toISOString(), sourceDirty: false, tools: { node: nodeVersion, npm: npmVersion, platform: process.platform, arch: process.arch }, packages };
await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'));
await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'));
console.log(JSON.stringify({ status: 'prepared', output, commit, packages: packages.map(value => ({ name: value.name, sha256: value.sha256 })) }));
