import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoggedCommand } from '../logged-command.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { file: process.execPath, cwd: root, logPath: join(root, 'command.log'), timeoutMs: 5000 };
}
test('captured command retains stdout, stderr and actual failure code', async t => {
  const options = await setup(t);
  const result = await runLoggedCommand({ ...options, args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode=7;'] });
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 7);
  assert.equal(await readFile(options.logPath, 'utf8'), 'out\nerr');
  assert.deepEqual(JSON.parse(await readFile(options.logPath + '.command.json', 'utf8')), result);
});
test('actual timeout retains partial output and never becomes a successful exit', async t => {
  const options = await setup(t);
  const result = await runLoggedCommand({ ...options, timeoutMs: 1000, args: ['-e', 'process.stdout.write("before timeout"); setInterval(()=>{},1000);'] });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert((await readFile(options.logPath, 'utf8')).includes('before timeout'));
  assert.equal(result.descendantCleanup, 'unverified');
});
test('deadline stays interrupted even when the child handles termination and exits zero', { skip: process.platform === 'win32' }, async t => {
  const options = await setup(t);
  const result = await runLoggedCommand({ ...options, timeoutMs: 1000, args: ['-e', 'process.on("SIGTERM",()=>process.exit(0)); process.stdout.write("ready"); setInterval(()=>{},1000);'] });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 0);
});
test('output limit and launch failure produce separate durable receipts', async t => {
  const options = await setup(t);
  const limit = await runLoggedCommand({ ...options, maxBuffer: 1024, args: ['-e', 'process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000);'] });
  assert.equal(limit.status, 'output-limit');
  assert((await readFile(options.logPath, 'utf8')).length > 0);
  const missing = await runLoggedCommand({ ...options, file: join(options.cwd, 'missing-command'), args: [] });
  assert.equal(missing.status, 'launch-failed');
  assert.equal(missing.errorCode, 'ENOENT');
});
