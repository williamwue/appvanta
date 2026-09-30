import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, chmod, access, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const python = process.argv[2]; assert(python, 'Specify Perfetto Python executable');
const root = resolve('.appvanta/runs', `perfetto-startup-${Date.now()}`); await mkdir(root, { recursive: true });
const fixture = join(root, 'unready.py'), checkpoint = join(root, 'started.json');
await writeFile(fixture, `#!/usr/bin/env python3\nimport json, os, time\nfrom pathlib import Path\nPath(${JSON.stringify(checkpoint.replaceAll('\\', '/'))}).write_text(json.dumps({'pid':os.getpid()}))\ntime.sleep(90)\n`);
if (process.platform !== 'win32') await chmod(fixture, 0o700);
const trace = join(root, 'input.trace'), cancel = join(root, 'cancel.json'), output = join(root, 'analysis');
await writeFile(trace, 'Startup fixture; never parsed');
const child = spawn(python, ['scripts/analyze-perfetto.py', '--trace', trace, '--package', 'dev.appvanta.fixture', '--output', output, '--processor', fixture, '--cancel-file', cancel], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit'); let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
let processInfo, requestedAt;
try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { processInfo = JSON.parse(await readFile(checkpoint, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (child.exitCode !== null) throw new Error(stderr);
    await delay(20);
  }
  assert(processInfo, 'Startup fixture did not launch');
  process.kill(processInfo.pid, 0);
  requestedAt = Date.now(); await writeFile(cancel, '{}');
  let timer;
  const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Startup cancellation exceeded 45 seconds')), 45000); })]).finally(() => clearTimeout(timer));
  const elapsedMs = Date.now() - requestedAt;
  assert(elapsedMs < 5000, 'Cancellation must not wait for server startup timeout');
  assert.equal(result[0], 1);
  assert.throws(() => process.kill(processInfo.pid, 0), { code: 'ESRCH' });
  const analysis = JSON.parse(await readFile(join(output, 'analysis.json'), 'utf8'));
  assert.equal(analysis.status, 'cancelled'); assert.equal(analysis.cancellation.requested, true);
  assert.throws(() => process.kill(analysis.cancellation.processorPid, 0), { code: 'ESRCH' });
  assert.equal(analysis.cancellation.processorExited, true);
  assert.equal(analysis.cancellation.cleanupError, null);
  const processor = JSON.parse(await readFile(join(output, 'processor.json'), 'utf8'));
  assert.equal(processor.pid, analysis.cancellation.processorPid);
  assert.equal(processor.phase, 'starting-server');
  for (const name of ['metrics.json', 'report.md']) await assert.rejects(access(join(output, name)));
  const verification = { status: 'passed', scope: 'direct-python-unready-server-cancellation', root, elapsedMs,
    fixturePid: processInfo.pid, fixtureExited: true, analysis, stdout, stderr,
    limitation: 'Direct Python startup cancellation with a non-serving executable; not SDK/MCP startup or real server readiness' };
  const injection = join(root, 'fixture'); await mkdir(injection);
  await writeFile(join(injection, 'sitecustomize.py'), `import os\nfrom perfetto.trace_processor.platform import PlatformDelegate\nPlatformDelegate.get_shell_path = lambda self, bin_path, fetch_latest=False: os.environ['APPVANTA_STARTUP_EXECUTABLE']\n`);
  verification.clients = [];
  for (const client of ['sdk', 'mcp']) {
    await unlink(checkpoint);
    const result = await promisify(execFile)(process.execPath, ['scripts/verify-perfetto-initialization-client.mjs', root, python, client, 'startup'],
      { windowsHide: true, encoding: 'utf8', timeout: 45000, env: { ...process.env, PYTHONPATH: injection, APPVANTA_STARTUP_EXECUTABLE: fixture } });
    verification.clients.push(JSON.parse(result.stdout));
  }
  verification.scope = 'direct-python-sdk-mcp-unready-server-cancellation';
  verification.limitation = 'Non-serving executable startup fixture; real trace readiness is covered by separate analysis regressions';
  await writeFile(join(root, 'verification.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, elapsedMs }));
} catch (error) {
  await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), processInfo, requestedAt, stdout, stderr }, null, 2)); throw error;
} finally {
  await writeFile(cancel, '{}');
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
}
