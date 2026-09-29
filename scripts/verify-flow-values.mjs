import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AdbDriver } from '../packages/android/dist/index.js';
import { startAppOps } from '../packages/android/dist/appops-fixture.js';
import { withDeviceLock, inspectDeviceLock, inspectFlowProgress, recordedFlow } from '../packages/core/dist/index.js';
import { readMcpResponses } from './mcp-response-reader.mjs';

const device = process.argv[2]; assert(device, 'Device required');
const directory = resolve('.appvanta/runs', `flow-values-${Date.now()}`); await mkdir(directory, { recursive: true });
const adb = async (...args) => (await promisify(execFile)(process.env.ADB_PATH ?? 'adb', ['-s', device, ...args], { windowsHide: true, timeout: 20000, encoding: 'utf8' })).stdout;
const driver = new AdbDriver({ artifactsDirectory: join(directory, 'observations') });
const target = { kind: 'resource-id', value: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor' };
const original = `AppVantaValue${randomUUID().replaceAll('-', '')} 中文 café & < >\n`;
const path = `/storage/emulated/0/Documents/markor/Value${randomUUID().replaceAll('-', '')}.txt`;
const flow = { name: 'Extract and reuse visible text', steps: [
  { description: 'Extract original note', extract: { name: 'note', target, attribute: 'text' } },
  { description: 'Insert extracted note', inputValue: { name: 'note', target } },
  { description: 'Save note', action: { kind: 'tap', target: { kind: 'accessibility-label', value: 'Save' } } },
] };
const flowPath = join(directory, 'flow.json'); await writeFile(flowPath, JSON.stringify(flow, null, 2));
const originalPath = join(directory, 'original.txt'); await writeFile(originalPath, original);
const ime = async () => ({ selected: (await adb('shell', 'settings', 'get', 'secure', 'default_input_method')).trim(), enabled: (await adb('shell', 'ime', 'list', '-s')).trim().split(/\r?\n/).sort() });
const beforeIme = await ime(); let storage, owned = false;
const results = [];
try {
  await withDeviceLock(device, async () => {
    assert((await adb('shell', 'ime', 'list', '-a', '-s')).split(/\r?\n/).includes('dev.appvanta.input/.InputService'), 'Install input helper');
    await adb('shell', 'test', '!', '-e', path);
    storage = await startAppOps([{ packageName: 'net.gsantner.markor', operation: 'MANAGE_EXTERNAL_STORAGE', mode: 'allow' }], device, directory);
  });
  for (const transport of ['cli', 'mcp', 'crash-continuation']) {
    await withDeviceLock(device, async () => {
      await driver.stopApp(device, 'net.gsantner.markor');
      if (owned) assert.equal(await adb('exec-out', 'cat', path), original.repeat(2), 'Refuse to overwrite external edits');
      await adb('push', originalPath, path); owned = true;
      await adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `file://${path}`, '-t', 'text/plain', '-n', 'net.gsantner.markor/.activity.DocumentActivity');
      await driver.execute(device, { kind: 'wait', condition: { kind: 'target-visible', target }, timeoutMs: 15000 });
    });
    let result, extractionRun;
    if (transport === 'cli') result = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'run-flow', device, flowPath], { windowsHide: true, timeout: 120000, encoding: 'utf8' })).stdout);
    else if (transport === 'crash-continuation') {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { TaskStore, parseFlow } from ${JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href)};
        import { runAndroidFlow } from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};
        const store = new TaskStore(${JSON.stringify(resolve('.appvanta/tasks'))});
        const flow = parseFlow(${JSON.stringify(flow)}), task = await store.create(${JSON.stringify(device)}, flow);
        task.status = 'running'; await store.save(task); let count = 0;
        await runAndroidFlow(task.deviceId, flow, undefined, async run => { task.runDirectory = run; await store.save(task); }, {
          drain: async () => [], finish: async () => {}, beforeStep: async () => {
            if (++count === 2) { process.send({ taskId: task.id, runDirectory: task.runDirectory }); await new Promise(() => setInterval(() => {}, 1000)); }
          }
        });`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
      let source;
      try {
        [source] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(90000) }), exited.then(() => { throw new Error(stderr); })]);
        assert.equal((await inspectDeviceLock(device)).lease.pid, child.pid);
        child.kill('SIGKILL'); await exited;
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
      extractionRun = source.runDirectory;
      const lock = await inspectDeviceLock(device); assert.equal(lock.owner, 'dead');
      const checkpoint = join(directory, 'checkpoint.json'); await writeFile(checkpoint, JSON.stringify({ kind: 'target-visible', target }));
      result = JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', 'continue-task', source.taskId, lock.lease.token, checkpoint], { windowsHide: true, timeout: 120000, encoding: 'utf8' })).stdout);
      result.steps = (await readFile(join(result.runDirectory, 'steps.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
      const continued = JSON.parse(await readFile(join(result.runDirectory, 'flow.json'), 'utf8'));
      assert.equal(continued.values.note, original);
      assert(!continued.steps.some(step => step.extract), 'Continuation must not re-extract');
      await writeFile(join(directory, 'crash-source.json'), JSON.stringify({ source, lock }, null, 2));
    } else {
      const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
      try {
        const ready = readMcpResponses(child.stdout, [1]);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'value-verifier', version: '1' } } }) + '\n'); await ready;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const pending = readMcpResponses(child.stdout, [2], 120000);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_flow', arguments: { deviceId: device, flow } } }) + '\n');
        const response = (await pending).find(item => item.id === 2);
        await writeFile(join(directory, 'mcp-response.json'), JSON.stringify(response, null, 2));
        assert(response?.result && !response.result.isError, JSON.stringify({ response, stderr }));
        result = JSON.parse(response.result.content[0].text);
      } finally { child.kill(); await exited; }
    }
    assert.equal(result.status, 'passed');
    if (transport !== 'crash-continuation') { assert.equal(result.cleanupFailed, false); assert.equal(result.steps[0].output, original); }
    const receipt = JSON.parse(await readFile(join(extractionRun ?? result.runDirectory, 'value-1.json'), 'utf8'));
    assert.equal(receipt.value, original);
    assert.equal((await inspectFlowProgress(result.runDirectory)).completedSteps, 3);
    const replay = await recordedFlow(result.runDirectory);
    assert.equal(replay.steps.find(step => step.action?.kind === 'input').action.text, original);
    assert.equal(await adb('exec-out', 'cat', path), original.repeat(2));
    assert.deepEqual(await ime(), beforeIme); assert.equal(await inspectDeviceLock(device), null);
    results.push({ transport, result, replay });
  }
  await withDeviceLock(device, async () => {
    await driver.stopApp(device, 'net.gsantner.markor');
    assert.equal(await adb('exec-out', 'cat', path), original.repeat(2));
    await adb('shell', 'rm', path); owned = false; await storage.stop();
  });
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'passed', device, original, path, results, beforeIme, afterIme: await ime(), ownedNoteRemoved: true }, null, 2));
  console.log(JSON.stringify({ status: 'passed', directory }));
} catch (error) {
  if (storage && !await inspectDeviceLock(device)) await withDeviceLock(device, () => storage.stop());
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), path, owned, results, lease: await inspectDeviceLock(device) }, null, 2));
  throw error;
}
