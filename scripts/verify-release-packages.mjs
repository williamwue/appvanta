import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const root = resolve('.');
const workspace = await mkdtemp(join(tmpdir(), 'appvanta-release-'));
const tarballs = join(workspace, 'tarballs');
await mkdir(tarballs);
const run = async (file, args, options = {}) => promisify(execFile)(file, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
const runNpm = async (args, options = {}) => {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args], options);
  return run('npm', args, options);
};
let mcpChild;
let verificationError;

const stopMcpChild = async child => {
  if (!child) return;
  const closed = once(child, 'close');
  const active = child.exitCode === null && child.signalCode === null;
  if (active) {
    try { child.stdin?.end(); } catch {}
    const exited = once(child, 'exit');
    try { child.kill(); } catch {}
    await Promise.race([exited, new Promise(resolveExit => setTimeout(resolveExit, 5000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
      await Promise.race([once(child, 'exit'), new Promise(resolveExit => setTimeout(resolveExit, 1000))]);
    }
  }
  await Promise.race([closed, new Promise(resolveClose => setTimeout(resolveClose, 5000))]);
  try { child.stdin?.destroy(); } catch {}
  try { child.stdout?.destroy(); } catch {}
  try { child.stderr?.destroy(); } catch {}
};

const cleanupWorkspace = async path => {
  const deadline = Date.now() + 60000;
  let lastError;
  while (Date.now() < deadline) {
    try { await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); return; }
    catch (error) {
      lastError = error;
      if (!error || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
      await new Promise(resolveRetry => setTimeout(resolveRetry, 500));
    }
  }
  throw lastError ?? new Error(`Timed out cleaning verifier workspace: ${path}`);
};

try {
  await runNpm(['run', 'build'], { cwd: root });
  const packages = ['core', 'android', 'cli', 'mcp'];
  const dependencies = {};
  for (const name of packages) {
    const result = await runNpm(['pack', '--workspace', `@appvanta/${name}`, '--pack-destination', tarballs, '--json'], { cwd: root });
    const packed = JSON.parse(result.stdout)[0];
    assert(packed.files.some(file => file.path === 'dist/LICENSE'), `${name} package is missing LICENSE`);
    assert(packed.files.some(file => file.path === 'dist/THIRD_PARTY_NOTICES.md'), `${name} package is missing third-party notices`);
    assert(!packed.files.some(file => /\.(?:apk|dylib|pem|key)$/i.test(file.path)), `${name} package contains a prohibited binary or key file`);
    if (name === 'android') for (const runtime of ['capture-network.py', 'network-addon.py', 'network_finalization.py', 'proxy_recovery.py', 'analyze-perfetto.py']) assert(packed.files.some(file => file.path === `dist/runtime/${runtime}`), `android package is missing ${runtime}`);
    dependencies[`@appvanta/${name}`] = `file:${join(tarballs, packed.filename).replaceAll('\\', '/')}`;
  }
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'appvanta-release-verification', private: true, dependencies }, null, 2));
  await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: workspace });

  const cli = join(workspace, 'node_modules/@appvanta/cli/dist/index.js');
  const help = await run(process.execPath, [cli], { cwd: workspace });
  assert.match(help.stdout, /AppVanta CLI/);
  const doctor = await run(process.execPath, [cli, 'doctor'], { cwd: workspace });
  const doctorReport = JSON.parse(doctor.stdout);
  assert(['ready', 'degraded'].includes(doctorReport.verdict), JSON.stringify(doctorReport));

  const mcp = join(workspace, 'node_modules/@appvanta/mcp/dist/index.js');
  const child = mcpChild = spawn(process.execPath, [mcp], { cwd: workspace, env: { ...process.env, APPVANTA_PROJECT_ROOT: workspace }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-check', version: '1' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const deadline = Date.now() + 10000;
  while (!output.split('\n').some(line => line.includes('"id":2'))) { if (Date.now() > deadline) throw new Error(`MCP timeout: ${output}`); await new Promise(done => setTimeout(done, 25)); }
  const messages = output.trim().split('\n').map(JSON.parse);
  assert(messages.find(message => message.id === 1)?.result?.serverInfo?.name);
  assert(messages.find(message => message.id === 2)?.result?.tools?.length > 10);
  await stopMcpChild(child);
  mcpChild = undefined;

  assert((await stat(join(workspace, 'node_modules/@appvanta/android/dist/runtime/capture-network.py'))).isFile());
  const result = { status: 'passed', packages, doctor: doctorReport.verdict, tools: messages.find(message => message.id === 2).result.tools.length };
  const outputDirectory = join(root, '.appvanta');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'release-package-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  verificationError = error;
  throw error;
} finally {
  let cleanupError;
  try { await stopMcpChild(mcpChild); }
  catch (error) { cleanupError = error; }
  try { await cleanupWorkspace(workspace); }
  catch (error) { cleanupError ??= error; }
  // Preserve the verification failure if cleanup also fails. A successful
  // verification still reports bounded cleanup failure to avoid hiding leaks.
  if (!verificationError && cleanupError) throw cleanupError;
}
