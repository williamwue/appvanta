import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRunContext, executeFlow, parseFlow, inspectFlowProgress, prepareFlowContinuation, recordedFlow } from '../dist/index.js';

const condition = { kind: 'text-visible', text: 'Ready' };
const branch = equals => ({ key: 'ready', when: condition, equals });
const device = { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] };
const observe = async () => ({ capturedAt: new Date().toISOString(), metadata: {} });

test('one branch decision selects multiple steps despite later state changes and rejects tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-branch-'));
  try {
    for (const selected of [true, false]) {
      let calls = 0; const actions = [];
      const driver = { name: 'branch-test', observe, checkCondition: async () => { calls++; return calls === 1 ? selected : !selected; },
        execute: async (_device, action) => { actions.push(action.button); return { success: true }; } };
      const context = await createRunContext({ runsDirectory: root, driver, device });
      const flow = parseFlow({ name: 'Branch', steps: [
        { description: 'Then one', branch: branch(true), action: { kind: 'button', button: 'home' } },
        { description: 'Then two', branch: branch(true), action: { kind: 'button', button: 'back' } },
        { description: 'Else', branch: branch(false), action: { kind: 'button', button: 'menu' } },
      ] });
      const result = await executeFlow({ context, driver, flow });
      assert.equal(result.status, 'passed'); assert.equal(calls, 1);
      assert.deepEqual(actions, selected ? ['home', 'back'] : ['menu']);
      assert.deepEqual(result.steps.map(step => step.status), selected ? ['passed', 'passed', 'skipped'] : ['skipped', 'skipped', 'passed']);
      assert.equal((await inspectFlowProgress(context.rootDirectory)).completedSteps, 3);
      const replay = await recordedFlow(context.rootDirectory);
      assert.deepEqual(replay.steps.filter(step => step.action).map(step => step.action.button), actions);
      const decisionPath = join(context.rootDirectory, 'branch-ready.json');
      const decision = JSON.parse(await readFile(decisionPath, 'utf8')); decision.matched = !decision.matched;
      await writeFile(decisionPath, JSON.stringify(decision));
      await assert.rejects(inspectFlowProgress(context.rootDirectory), /Branch|evidence/i);
      await assert.rejects(recordedFlow(context.rootDirectory), /Branch|evidence/i);
    }
    assert.throws(() => parseFlow({ name: 'Inconsistent branch', steps: [
      { description: 'One', branch: branch(true), echo: 'one' },
      { description: 'Two', branch: { ...branch(false), when: { kind: 'text-absent', text: 'Ready' } }, echo: 'two' },
    ] }), /inconsistent/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('branch query failure and unselected child conditions never execute operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-branch-error-'));
  try {
    for (const fails of [false, true]) {
      let queries = 0, actions = 0;
      const driver = { name: 'branch-error', observe, checkCondition: async () => { queries++; if (fails) throw new Error('Device offline'); return false; }, execute: async () => { actions++; return { success: true }; } };
      const context = await createRunContext({ runsDirectory: root, driver, device });
      const result = await executeFlow({ context, driver, flow: parseFlow({ name: 'Gate', steps: [
        { description: 'Never execute', branch: branch(true), when: { kind: 'app-running', packageName: 'app.test' }, action: { kind: 'back' } },
      ] }) });
      assert.equal(queries, 1); assert.equal(actions, 0); assert.equal(result.status, fails ? 'failed' : 'passed');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a selected branch with a false child condition retains the branch decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-branch-child-'));
  try {
    let queries = 0;
    const driver = { name: 'branch-child', observe, checkCondition: async (_device, condition) => { queries++; return condition.kind === 'text-visible'; }, execute: async () => { throw new Error('Skipped action executed'); } };
    const context = await createRunContext({ runsDirectory: root, driver, device });
    const result = await executeFlow({ context, driver, flow: parseFlow({ name: 'Child guard', steps: [
      { description: 'Selected but locally skipped', branch: branch(true), when: { kind: 'app-running', packageName: 'absent.app' }, action: { kind: 'back' } },
      { description: 'Else remains unselected', branch: branch(false), echo: 'wrong branch' },
    ] }) });
    assert.equal(result.status, 'passed'); assert.equal(queries, 2);
    assert.equal(result.steps[0].branchMatched, true); assert.equal(result.steps[0].conditionMatched, false);
    assert.equal(result.steps[1].branchMatched, false);
    assert.equal((await inspectFlowProgress(context.rootDirectory)).completedSteps, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a real owner crash after first branch step freezes the original decision in continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-branch-crash-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/branch-crash.fixture.mjs', import.meta.url)), root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(15000) }), exited.then(() => { throw new Error(stderr); })]);
    child.kill('SIGKILL'); await exited;
    const prepared = await prepareFlowContinuation(message.root, condition);
    assert.equal(prepared.resumeAuthorized, false);
    assert(prepared.flow.steps.slice(1).every(step => step.branch.resolved === true));
    let branchQueries = 0; const actions = [];
    const driver = { name: 'branch-resume', observe, checkCondition: async () => { branchQueries++; return false; }, execute: async (_device, action) => { actions.push(action.kind === 'button' ? action.button : action.kind); return { success: true }; } };
    const context = await createRunContext({ runsDirectory: root, driver, device });
    const result = await executeFlow({ context, driver, flow: prepared.flow });
    assert.equal(result.status, 'passed'); assert.equal(branchQueries, 0); assert.deepEqual(actions, ['wait', 'back']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
