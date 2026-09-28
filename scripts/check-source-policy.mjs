import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = name => readFile(resolve(root, name), 'utf8');
const required = ['LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'docs/upgrading.md', 'docs/reference-baselines.md', 'docs/competitor-coverage.md', 'docs/release-checklist.md'];
await Promise.all(required.map(read));

const license = await read('LICENSE');
assert.match(license, /Apache License\s+Version 2\.0/);
assert.match(license, /Copyright 2026 AppVanta contributors\./);
assert.doesNotMatch(license, /Google LLC|Software Mansion|Minitap/);

const manifests = ['package.json', 'packages/core/package.json', 'packages/android/package.json', 'packages/cli/package.json', 'packages/mcp/package.json'];
for (const path of manifests) {
  const value = JSON.parse(await read(path));
  assert.equal(value.license, 'Apache-2.0', `${path} must declare Apache-2.0`);
  assert.equal(value.private, true, `${path} must remain private until package release gates pass`);
}

const lock = JSON.parse(await read('package-lock.json'));
const allowed = new Set(['Apache-2.0', 'MIT', 'BSD-3-Clause', 'ISC']);
for (const [path, value] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || value.link) continue;
  assert.equal(typeof value.license, 'string', `${path} has no lockfile license`);
  assert(allowed.has(value.license), `${path} uses unreviewed license ${value.license}`);
}

for (const path of ['scripts/network-requirements.txt', 'scripts/perfetto-requirements.txt']) {
  const lines = (await read(path)).trim().split(/\r?\n/).filter(Boolean);
  assert(lines.length > 0);
  for (const line of lines) assert.match(line, /^[a-z0-9_-]+==\d+(?:\.\d+)+(?:[a-z0-9.-]+)?$/i, `${path} contains an unpinned or external requirement`);
}

const baseline = await read('docs/reference-baselines.md');
for (const sha of ['371aa6df56880643da57b30da936e9812fb0ec66', '37fe85a0cc1a88b80023fe5705312f66912cf431']) assert(baseline.includes(sha), `Missing fixed reference ${sha}`);

const { stdout } = await promisify(execFile)('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer', windowsHide: true });
const tracked = stdout.toString('utf8').split('\0').filter(Boolean);
const prohibited = tracked.filter(path => path.startsWith('.appvanta/reference/') || /(^|\/)(simulator-server|ax-service)(\/|$)|\.(?:apk|dylib|pem|key|p12|jks|keystore)$/i.test(path));
assert.deepEqual(prohibited, [], `Reference source or restricted binary is tracked: ${prohibited.join(', ')}`);
const privateKeyMarkers = ['', 'RSA ', 'OPENSSH '].map(kind => Buffer.from(`-----BEGIN ${kind}PRIVATE ${'KEY'}-----`));
const privateKeyEnds = ['', 'RSA ', 'OPENSSH '].map(kind => Buffer.from(`-----END ${kind}PRIVATE ${'KEY'}-----`));
for (const path of tracked.filter(path => !/\.(?:png|jpg|jpeg|gif|ico|pdf|zip|gz)$/i.test(path))) {
  const content = await readFile(resolve(root, path));
  assert(!privateKeyMarkers.some((marker, index) => content.includes(marker) && content.includes(privateKeyEnds[index])), `Tracked private key block: ${path}`);
}

console.log(JSON.stringify({ status: 'passed', requiredFiles: required.length, manifests: manifests.length, dependencies: Object.keys(lock.packages).filter(path => path.startsWith('node_modules/') && !lock.packages[path].link).length, trackedFiles: tracked.length }));
