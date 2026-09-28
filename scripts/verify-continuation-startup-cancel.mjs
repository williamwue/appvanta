import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore, inspectDeviceLock } from '../packages/core/dist/index.js';
import { recoverAndroidFlow, continueAndroidTask } from '../packages/android/dist/index.js';
import { startContinuation } from '../packages/mcp/dist/start-continuation.js';

const deviceId = process.argv[2]; assert(deviceId, 'Device ID required');
const root = resolve('.appvanta/runs', `startup-cancel-${Date.now()}`); await mkdir(root, { recursive: true });
const store = new TaskStore(resolve('.appvanta/tasks'));
const source = `
import {TaskStore,parseFlow} from ${JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href)};
import {runAndroidFlow} from ${JSON.stringify(new URL('../packages/android/dist/index.js', import.meta.url).href)};
const store=new TaskStore(${JSON.stringify(store.directory)});
const flow=parseFlow({name:'Startup cancellation source',steps:[{description:'Completed home',action:{kind:'button',button:'home'}},{description:'Must not resume',action:{kind:'back'}}]});
const task=await store.create(${JSON.stringify(deviceId)},flow);task.status='running';await store.save(task);
let count=0;
await runAndroidFlow(task.deviceId,flow,undefined,async root=>{task.runDirectory=root;await store.save(task);},{drain:async()=>[],finish:async()=>{},beforeStep:async()=>{
if(++count===2){process.send({taskId:task.id,root:task.runDirectory});await new Promise(()=>setInterval(()=>{},1000));}
}});
`;
const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const exited = once(owner, 'exit'); let stderr = ''; owner.stderr.on('data', data => { stderr += data; });
try {
  const [message] = await Promise.race([once(owner, 'message', { signal: AbortSignal.timeout(90000) }), exited.then(() => { throw new Error(stderr); })]);
  owner.kill('SIGKILL'); await exited;
  assert.equal((await store.get(message.taskId)).status, 'interrupted');
  const initial = await inspectDeviceLock(deviceId); assert.equal(initial.owner, 'dead');
  if (process.argv[3] === 'transfer-crash') {
    const code = `import {continueAndroidFlow} from ${JSON.stringify(new URL('../packages/android/dist/recover-flow.js', import.meta.url).href)};
      await continueAndroidFlow(${JSON.stringify(deviceId)},${JSON.stringify(initial.lease.token)},async()=>{process.send('transferred');await new Promise(()=>setInterval(()=>{},1000));});`;
    const worker = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const workerExit = once(worker, 'exit');
    try {
      await Promise.race([once(worker, 'message', { signal: AbortSignal.timeout(60000) }), workerExit.then(() => { throw new Error('Worker exited before transfer'); })]);
      const transferred = await inspectDeviceLock(deviceId);
      assert.equal(transferred.lease.pid, worker.pid);
      assert.equal(transferred.lease.preparationScope, 'android-flow');
      assert.equal(transferred.lease.runDirectory, undefined);
      assert.equal(transferred.lease.recoveredFrom.token, initial.lease.token);
      worker.kill('SIGKILL'); await workerExit;
      const recovered = await recoverAndroidFlow(deviceId, transferred.lease.token);
      assert.equal(recovered.scope, 'pre-continuation-binding');
      assert.equal(await inspectDeviceLock(deviceId), null);
      await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', scenario: 'transfer-crash', source: message, transferred, recovered }, null, 2));
      console.log(JSON.stringify({ status: 'passed', root, scenario: 'transfer-crash' }));
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await workerExit; }
    }
  } else {
  const controller = new AbortController();
  let settled = false;
  const started = startContinuation(store, message.taskId, initial.lease.token, { kind: 'app-running', packageName: 'com.android.systemui' }, controller.signal)
    .then(value => ({ value }), error => ({ error: String(error) })).finally(() => { settled = true; });
  const claimPath = join(store.directory, message.taskId, 'continuation/claim.json');
  let claim;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !settled) {
    try { claim = JSON.parse(await readFile(claimPath, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(5);
  }
  assert(claim, 'Must observe the reserved continuation before cancellation');
  controller.abort(new Error('Verifier cancels during startup recovery'));
  const response = await started;
  assert.match(response.error, /cancellation recorded/);
  const match = response.error.match(/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/);
  assert(match, response.error);
  const requestRoot = resolve('.appvanta/continuations', match[1]);
  let workerError;
  const terminalDeadline = Date.now() + 90000;
  while (Date.now() < terminalDeadline) {
    try { workerError = JSON.parse(await readFile(join(requestRoot, 'error.json'), 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(50);
  }
  assert.match(workerError?.error ?? '', /startup cancellation requested/);
  await assert.rejects(access(join(requestRoot, 'ready.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(store.directory, message.taskId, 'continuation/successor.json')), { code: 'ENOENT' });
  const retained = await inspectDeviceLock(deviceId);
  assert.equal(retained.lease.token, initial.lease.token, 'Cancellation must retain the original bound lease');
  assert.equal(retained.lease.runDirectory, message.root);
  let recovered;
  if (process.argv[3] === 'retry') {
    const exitDeadline = Date.now() + 10000;
    while (true) {
      try { process.kill(workerError.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      assert(Date.now() < exitDeadline, 'Cancelled worker must exit before retry');
      await delay(50);
    }
    recovered = await continueAndroidTask(store, message.taskId, retained.lease.token, { kind: 'app-running', packageName: 'com.android.systemui' });
    assert.equal(recovered.status, 'passed');
    const steps = (await readFile(join(recovered.runDirectory, 'steps.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(steps.length, 2);
    assert(!steps.some(step => step.description === 'Completed home'));
  } else recovered = await recoverAndroidFlow(deviceId, retained.lease.token);
  assert.equal(await inspectDeviceLock(deviceId), null);
  const evidence = { status: 'passed', deviceId, source: message, requestRoot, claim, response, workerError, recovered,
    retry: process.argv[3] === 'retry',
    limitations: ['Cancellation observed after reservation during API 37 device recovery', 'Does not test retry after successor creation or uncertain business actions'] };
  await writeFile(join(root, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: 'passed', root, requestRoot }));
  }
} finally {
  if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await exited; }
}
