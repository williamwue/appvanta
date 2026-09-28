import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const run = (args, options = {}) => promisify(execFile)('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
const commits = (await run(['rev-list', '--all'])).stdout.trim().split(/\r?\n/).filter(Boolean);
assert(commits.length > 0, 'Git history is empty');

const objects = (await run(['rev-list', '--objects', '--all'])).stdout.split(/\r?\n/).filter(Boolean).map(line => {
  const separator = line.indexOf(' ');
  return separator < 0 ? { object: line, path: '' } : { object: line.slice(0, separator), path: line.slice(separator + 1) };
});
const prohibitedPaths = [...new Set(objects.map(value => value.path).filter(Boolean).filter(path =>
  path.startsWith('.appvanta/reference/') ||
  /(^|\/)(simulator-server|ax-service)(\/|$)/i.test(path) ||
  /\.(?:apk|aab|dylib|so|dll|exe|pem|key|p12|pfx|jks|keystore)$/i.test(path) ||
  (/(^|\/)\.env(?:\.|$)/i.test(path) && !/\.env\.example$/i.test(path))
))];
assert.deepEqual(prohibitedPaths, [], `Restricted historical paths: ${prohibitedPaths.join(', ')}`);

const grepHistory = async pattern => {
  const locations = new Set();
  for (let offset = 0; offset < commits.length; offset += 50) {
    try {
      const result = await run(['grep', '-I', '-l', '-E', '-e', pattern, ...commits.slice(offset, offset + 50)]);
      for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) locations.add(line);
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 1) throw error;
    }
  }
  return [...locations];
};
const pemLocations = (await grepHistory('-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----')).filter(location => !location.endsWith(':scripts/test/stage-evidence.test.mjs'));
const tokenLocations = await grepHistory('AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,}');
assert.deepEqual([...pemLocations, ...tokenLocations], [], `High-confidence secret markers found at: ${[...pemLocations, ...tokenLocations].join(', ')}`);

console.log(JSON.stringify({ status: 'passed', commits: commits.length, objects: new Set(objects.map(value => value.object)).size, historicalPaths: new Set(objects.map(value => value.path).filter(Boolean)).size }));
