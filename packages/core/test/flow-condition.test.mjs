import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRunContext, executeFlow, parseFlow, inspectFlowProgress, recordedFlow, prepareFlowContinuation } from '../dist/index.js';

test('conditional steps preserve decisions, skip false actions, and exclude them from replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-condition-'));
  try {
    const actions = [], checks = [];
    const driver = { name: 'condition-test', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }),
      checkCondition: async (_device, condition) => { checks.push(condition.text); return condition.text === 'present'; },
      execute: async (_device, action) => { actions.push(action.button); return { success: true }; },
      launch: async () => { throw new Error('Skipped launch executed'); }, openUrl: async () => { throw new Error('Skipped URL executed'); } };
    const device = { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] };
    const context = await createRunContext({ runsDirectory: root, driver, device });
    const result = await executeFlow({ context, driver, flow: parseFlow({ name: 'Conditions', steps: [
      { description: 'Skip', when: { kind: 'text-visible', text: 'absent' }, launchPackage: 'app.test', openUrl: 'https://example.com', action: { kind: 'button', button: 'home' }, assertText: 'must not check', echo: 'must not emit' },
      { description: 'Run', when: { kind: 'text-visible', text: 'present' }, action: { kind: 'button', button: 'back' } },
    ] }) });
    assert.equal(result.status, 'passed'); assert.deepEqual(actions, ['back']); assert.deepEqual(checks, ['absent', 'present']);
    assert.deepEqual(result.steps.map(step => [step.status, step.conditionMatched]), [['skipped', false], ['passed', true]]);
    assert.equal(result.steps[0].output, undefined);
    const progress = JSON.parse(await readFile(join(result.runDirectory, 'progress.json'), 'utf8'));
    assert.equal(progress.completed.length, 2);
    assert.equal((await inspectFlowProgress(result.runDirectory)).completedSteps, 2);
    const replay = await recordedFlow(result.runDirectory);
    assert(!replay.steps.some(step => step.launchPackage || step.openUrl || step.action?.button === 'home'));
    assert(replay.steps.some(step => step.action?.button === 'back'));
    await writeFile(join(result.runDirectory, 'condition-1.json'), '{}');
    await assert.rejects(inspectFlowProgress(result.runDirectory), /condition|evidence/i);
    await assert.rejects(recordedFlow(result.runDirectory), /condition/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('condition errors and cancellation never run actions or recovery rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-condition-error-'));
  try {
    for (const cancel of [false, true]) {
      const controller = new AbortController(); let actions = 0;
      const driver = { name: 'condition-test', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }),
        checkCondition: async () => { if (cancel) { controller.abort(); return false; } throw new Error('Condition transport failed'); },
        execute: async () => { actions++; return { success: true }; } };
      const context = await createRunContext({ runsDirectory: root, driver, device: { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] } });
      const result = await executeFlow({ context, driver, signal: controller.signal, flow: parseFlow({ name: 'Error', steps: [{ description: 'Guard', when: { kind: 'text-visible', text: 'x' }, action: { kind: 'back' }, assertText: 'x', recovery: { maxAttempts: 1, rules: [{ description: 'Must not run', when: { kind: 'text-visible', text: 'x' }, action: { kind: 'back' } }] } }] }) });
      assert.equal(result.status, cancel ? 'cancelled' : 'failed'); assert.equal(actions, 0);
      assert.equal(result.steps[0].status, cancel ? 'cancelled' : 'failed');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a real owner exit after a skipped step preserves a resumable boundary without replaying that step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-condition-crash-'));
  const code = `import {createRunContext,executeFlow,parseFlow} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    const driver={name:'child',observe:async()=>({capturedAt:new Date().toISOString(),metadata:{}}),checkCondition:async()=>false,execute:async()=>{throw Error('Unexpected action')}};
    const context=await createRunContext({runsDirectory:${JSON.stringify(root)},driver,device:{id:'fake',name:'fake',platform:'android',status:'online',capabilities:[]}});
    let count=0;
    await executeFlow({context,driver,flow:parseFlow({name:'Crash',steps:[{description:'Skipped',when:{kind:'text-visible',text:'absent'},action:{kind:'back'}},{description:'Remaining',echo:'remaining'}]}),beforeStep:async()=>{if(++count===2){process.send({root:context.rootDirectory});await new Promise(()=>setInterval(()=>{},1000));}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ended = once(child, 'exit'); let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(10000) }), ended.then(() => { throw new Error(errors); })]);
    child.kill('SIGKILL'); await ended;
    const progress = await inspectFlowProgress(message.root);
    assert.equal(progress.boundaryConsistent, true); assert.equal(progress.completedSteps, 1); assert.equal(progress.remainingSteps, 1);
    const continuation = await prepareFlowContinuation(message.root, { kind: 'text-visible', text: 'Ready' });
    assert.deepEqual(continuation.flow.steps.map(step => step.description), ['Verify continuation checkpoint', 'Remaining']);
    assert.equal(continuation.resumeAuthorized, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
    await rm(root, { recursive: true, force: true });
  }
});
