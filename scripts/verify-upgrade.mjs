import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readMcpResponses } from './mcp-response-reader.mjs';

const root = resolve('.');
const baselineCommit = '93749a0cb87937149376aaac16adf8d199660acb';
const workspace = await mkdtemp(join(tmpdir(), 'appvanta-upgrade-'));
const baseline = join(workspace, 'baseline'), project = join(workspace, 'project');
const packages = ['core', 'android', 'cli', 'mcp'];
const output = resolve('.appvanta/runs', `upgrade-${Date.now()}`, 'verification.json');
const run = (file, args, cwd = root) => promisify(execFile)(file, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
const npm = (args, cwd = root) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], cwd) : run('npm', args, cwd);
const childCode = async code => JSON.parse((await run(process.execPath, ['--input-type=module', '-e', code], project)).stdout);
const hashes = [], evidence = { baselineCommit, platform: process.platform, workspace };
let mcp;
async function pack(source, label) {
  const destination = join(workspace, label); await mkdir(destination);
  const dependencies = {}, versions = [];
  for (const name of packages) {
    const value = JSON.parse((await npm(['pack', '--workspace', `@appvanta/${name}`, '--pack-destination', destination, '--json'], source)).stdout)[0];
    const path = join(destination, value.filename);
    dependencies[`@appvanta/${name}`] = `file:${path.replaceAll('\\', '/')}`;
    versions.push(value.version);
    hashes.push({ generation: label, name, version: value.version, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  assert.equal(new Set(versions).size, 1);
  return { dependencies, version: versions[0] };
}
async function install(dependencies) {
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'appvanta-upgrade-check', private: true, type: 'module', dependencies }, null, 2));
  await npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], project);
}
try {
  await mkdir(resolve(output, '..'), { recursive: true });
  evidence.candidateCommit = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
  evidence.sourceDirty = Boolean((await run('git', ['status', '--porcelain'])).stdout.trim());
  await mkdir(baseline); await mkdir(project);
  const archive = join(workspace, 'baseline.tar');
  await run('git', ['archive', '--format=tar', `--output=${archive}`, baselineCommit]);
  await run('tar', ['-xf', archive, '-C', baseline]);
  await npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], baseline);
  await npm(['run', 'build'], baseline);
  await npm(['run', 'build']);
  const from = await pack(baseline, 'old'), to = await pack(root, 'new');
  assert.equal(from.version, '0.1.0'); assert.notEqual(from.version, to.version, 'Upgrade must use distinct package versions');
  evidence.from = from.version; evidence.to = to.version;
  await install(from.dependencies);
  const oldRecords = await childCode(`
    import {TaskStore,BatchStore,MonitorStore} from '@appvanta/core';
    const store=new TaskStore('.appvanta/tasks');
    const flow={name:'Upgrade fixture',steps:[{description:'Must not execute on upgrade',action:{kind:'back'}}]};
    const completed=await store.create('upgrade-offline-device',flow);
    completed.status='passed';completed.finishedAt=new Date().toISOString();completed.result={note:'historical synthetic fixture'};await store.save(completed);
    const pending=await store.create('upgrade-offline-device',flow);
    const batches=new BatchStore('.appvanta/batches'), monitors=new MonitorStore('.appvanta/monitors');
    const batchCompleted=await batches.create(['upgrade-offline-device'],flow,1);
    batchCompleted.status='passed';batchCompleted.finishedAt=new Date().toISOString();await batches.save(batchCompleted);
    const batchPending=await batches.create(['upgrade-offline-device'],flow,1);
    const monitorCompleted=await monitors.create('upgrade-offline-device',500,1000);
    monitorCompleted.status='completed';monitorCompleted.finishedAt=new Date().toISOString();await monitors.save(monitorCompleted);
    const monitorPending=await monitors.create('upgrade-offline-device',500,1000);
    console.log(JSON.stringify({completed,pending,batchCompleted,batchPending,monitorCompleted,monitorPending}));
  `);
  assert.equal(oldRecords.completed.revision, undefined);
  const files = [oldRecords.completed.id, oldRecords.pending.id].map(id => join('.appvanta', 'tasks', id, 'task.json'));
  for (const key of ['batchCompleted', 'batchPending']) files.push(join('.appvanta', 'batches', oldRecords[key].id, 'batch.json'));
  for (const key of ['monitorCompleted', 'monitorPending']) files.push(join('.appvanta', 'monitors', oldRecords[key].id, 'monitor.json'));
  const unknown = join('.appvanta', 'future-record.json');
  await writeFile(join(project, unknown), '{"version":999,"payload":"preserve-unknown"}\n'); files.push(unknown);
  const before = new Map(await Promise.all(files.map(async file => [file, await readFile(join(project, file), 'utf8')])));
  const unchanged = async () => { for (const [file, bytes] of before) assert.equal(await readFile(join(project, file), 'utf8'), bytes, file); };
  await install(to.dependencies);
  for (const name of packages) assert.equal(JSON.parse(await readFile(join(project, 'node_modules', '@appvanta', name, 'package.json'), 'utf8')).version, to.version);
  const current = await childCode(`
    import {TaskStore,BatchStore,MonitorStore} from '@appvanta/core';
    const store=new TaskStore('.appvanta/tasks');
    const completed=await store.get(${JSON.stringify(oldRecords.completed.id)});
    const pending=await store.get(${JSON.stringify(oldRecords.pending.id)});
    const batches=new BatchStore('.appvanta/batches'), monitors=new MonitorStore('.appvanta/monitors');
    const batchCompleted=await batches.get(${JSON.stringify(oldRecords.batchCompleted.id)});
    const batchPending=await batches.get(${JSON.stringify(oldRecords.batchPending.id)});
    const monitorCompleted=await monitors.get(${JSON.stringify(oldRecords.monitorCompleted.id)});
    const monitorPending=await monitors.get(${JSON.stringify(oldRecords.monitorPending.id)});
    console.log(JSON.stringify({completed,pending,batchCompleted,batchPending,monitorCompleted,monitorPending}));
  `);
  assert.deepEqual(current.completed, oldRecords.completed);
  assert.equal(current.pending.status, 'interrupted');
  assert.deepEqual(current.pending.owner, oldRecords.pending.owner);
  for (const key of ['batchCompleted', 'monitorCompleted']) assert.deepEqual(current[key], oldRecords[key]);
  for (const key of ['batchPending', 'monitorPending']) {
    assert.equal(current[key].status, 'interrupted');
    assert.deepEqual(current[key].owner, oldRecords[key].owner);
  }
  await unchanged();
  const cli = join(project, 'node_modules/@appvanta/cli/dist/index.js');
  assert.match((await run(process.execPath, [cli], project)).stdout, /AppVanta CLI/);
  const doctor = JSON.parse((await run(process.execPath, [cli, 'doctor'], project)).stdout);
  assert(['ready', 'degraded'].includes(doctor.verdict));
  mcp = spawn(process.execPath, [join(project, 'node_modules/@appvanta/mcp/dist/index.js')], { cwd: project, env: { ...process.env, APPVANTA_PROJECT_ROOT: project }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = readMcpResponses(mcp.stdout, [1, 2, 3, 4]);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'upgrade-check', version: '1' } } }) + '\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_batch', arguments: { batchId: oldRecords.batchPending.id } } }) + '\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_monitor', arguments: { monitorId: oldRecords.monitorPending.id } } }) + '\n');
  const messages = await responses;
  assert.equal(messages.find(message => message.id === 1).result.serverInfo.version, to.version);
  assert(messages.find(message => message.id === 2).result.tools.length >= 55);
  for (const id of [3, 4]) {
    const result = messages.find(message => message.id === id).result;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(JSON.parse(result.content[0].text).status, 'interrupted');
  }
  const exit = once(mcp, 'exit'); mcp.kill(); await exit; mcp = undefined;
  await unchanged();
  await npm(['uninstall', ...packages.map(name => `@appvanta/${name}`), '--ignore-scripts', '--no-audit', '--no-fund'], project);
  for (const name of packages) await assert.rejects(stat(join(project, 'node_modules/@appvanta', name)), { code: 'ENOENT' });
  await unchanged();
  Object.assign(evidence, { status: 'passed', packages: hashes, doctor: doctor.verdict, records: files,
    legacyRecords: oldRecords, projectedRecords: current,
    recordHashes: [...before].map(([path, bytes]) => ({ path, sha256: createHash('sha256').update(bytes).digest('hex') })),
    legacyCompletedReadable: true, deadPendingInterrupted: true, unchangedThroughUninstall: true,
    legacyBatchesAndMonitorsReadable: true, mcpLegacyQueries: ['get_batch', 'get_monitor'],
    limitations: ['Historical v1 task, batch and monitor records are read without an on-disk rewrite; other data schemas, live workers and downgrade are not covered'] });
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: 'passed', output, from: from.version, to: to.version }));
  await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
} catch (error) {
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify({ ...evidence, status: 'failed', error: String(error) }, null, 2));
  throw error;
} finally {
  if (mcp && mcp.exitCode === null && mcp.signalCode === null) { const exit = once(mcp, 'exit'); mcp.kill(); await exit; }
}
