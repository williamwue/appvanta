import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRunContext, executeFlow, compileFlowTemplate, inspectFlowProgress, prepareFlowContinuation, recordedFlow, parseFlow } from '../dist/index.js';
import { prepareAdjudicatedFlowContinuation } from '../dist/flow-progress.js';
import { createHash } from 'node:crypto';

const condition = text => ({ kind: 'text-visible', text });
const echo = description => ({ description, echo: description });
test('first branch action killed during execution retains its decision in adjudication preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-active-branch-crash-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/branch-crash.fixture.mjs', import.meta.url)), root, 'active-branch'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(15000) }), exited.then(() => { throw new Error(stderr); })]);
    child.kill('SIGKILL'); await exited;
    const progress = await inspectFlowProgress(message.root);
    assert.equal(progress.phase, 'executing'); assert.equal(progress.completedSteps, 0);
    await assert.rejects(prepareFlowContinuation(message.root, condition('Checkpoint')), /Unsafe continuation boundary/);
    const prepared = await prepareAdjudicatedFlowContinuation(message.root, condition('Checkpoint'));
    assert.equal(prepared.resumeAuthorized, false);
    assert.equal(prepared.source.skippedStepIndex, 1);
    assert.equal(prepared.flow.steps.length, 3);
    assert.equal(prepared.flow.steps[1].branch.resolved, true);
    assert.equal(prepared.flow.steps[2].branch.resolved, true);
    const bytes = await readFile(join(message.root, 'branch-ready.json'));
    assert.deepEqual(prepared.source.activeBranchEvidenceSha256, { 'branch-ready.json': { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
    await rm(join(message.root, 'branch-ready.json'));
    await assert.rejects(prepareAdjudicatedFlowContinuation(message.root, condition('Checkpoint')), /remaining choice is not verified/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
const template = { name: 'Nested branches', variables: { inner: 'Inner' }, fragments: {
  child: { parameters: ['condition'], steps: [{ if: { kind: 'text-visible', text: { $var: 'condition' } }, then: [echo('inner true one'), echo('inner true two')], else: [echo('inner false')] }] },
}, steps: [{ if: condition('Outer'), then: [{ use: 'child', with: { condition: { $var: 'inner' } } }], else: [echo('outer false')] }] };

test('compiled nested branches short-circuit parents and evaluate each selected condition once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-nested-branch-'));
  try {
    const source = structuredClone(template), flow = compileFlowTemplate(source);
    assert.deepEqual(source, template); assert.deepEqual(parseFlow(flow), flow);
    assert.equal(flow.steps[0].branch.parents.length, 1);
    for (const outer of [true, false]) for (const inner of [true, false]) {
      const queries = [];
      const driver = { name: 'nested-branch-test', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }),
        checkCondition: async (_device, condition) => { queries.push(condition.text); return condition.text === 'Outer' ? outer : inner; } };
      const context = await createRunContext({ runsDirectory: root, driver, device: { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] } });
      const result = await executeFlow({ context, driver, flow });
      assert.equal(result.status, 'passed'); assert.deepEqual(queries, outer ? ['Outer', 'Inner'] : ['Outer']);
      assert.deepEqual(result.steps.filter(step => step.status === 'passed').map(step => step.output), !outer ? ['outer false'] : inner ? ['inner true one', 'inner true two'] : ['inner false']);
      assert.equal((await inspectFlowProgress(context.rootDirectory)).completedSteps, 4);
      await recordedFlow(context.rootDirectory);
      const files = await readdir(context.rootDirectory);
      assert.equal(files.filter(name => /^branch-.*\.json$/.test(name)).length, outer ? 2 : 1);
      if (outer) assert.equal(JSON.parse(await readFile(join(context.rootDirectory, 'branch-template_branch_2.json'), 'utf8')).matched, inner);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('template branches reject malformed arms, excessive nesting and reserved key collisions', () => {
  for (const step of [
    { if: condition('x'), then: [], else: [] }, { if: condition('x'), then: {} },
    { if: condition('x'), then: [echo('yes')], else: false }, { if: condition('x'), then: [echo('yes')], extra: true },
    { if: { kind: 'screen-stable', stableMs: 100 }, then: [echo('yes')] },
    { ...echo('reserved'), branch: { key: 'template_branch_1', when: condition('x'), equals: true } },
  ]) assert.throws(() => compileFlowTemplate({ name: 'Bad', steps: [step] }));
  let steps = [echo('deep')];
  for (let index = 0; index < 33; index++) steps = [{ if: condition('x'), then: steps }];
  assert.throws(() => compileFlowTemplate({ name: 'Deep', steps }), /nesting/);
  assert.equal(compileFlowTemplate({ name: 'Empty then', steps: [{ if: condition('x'), then: [], else: [echo('no')] }] }).steps[0].branch.equals, false);
});

test('native branch ancestry cannot repeat keys or change scope between steps', () => {
  const outer = { key: 'outer', when: condition('Outer'), equals: true };
  const inner = { key: 'inner', when: condition('Inner'), equals: true };
  assert.throws(() => parseFlow({ name: 'Cycle', steps: [{ ...echo('bad'), branch: { ...outer, parents: [outer] } }] }), /duplicate/);
  assert.throws(() => parseFlow({ name: 'Scope', steps: [{ ...echo('one'), branch: { ...inner, parents: [outer] } }, { ...echo('two'), branch: inner }] }), /inconsistent/);
});

for (const selected of [true, false]) test(`nested branch continuation preserves parent and child decisions after real crash: ${selected}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-nested-crash-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/branch-crash.fixture.mjs', import.meta.url)), root, `nested-${selected}`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(15000) }), exited.then(() => { throw new Error(stderr); })]);
    child.kill('SIGKILL'); await exited;
    const prepared = await prepareFlowContinuation(message.root, condition('Checkpoint'));
    const inner = prepared.flow.steps[1].branch;
    assert.equal(inner.parents[0].resolved, selected);
    assert.equal(inner.resolved, selected ? true : undefined, 'Unvisited inner branch must not acquire an invented decision');
    const driver = { name: 'nested-resume', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }),
      checkCondition: async () => { throw new Error('Continuation must not re-query or enter an unselected branch'); }, execute: async () => ({ success: true }) };
    const context = await createRunContext({ runsDirectory: root, driver, device: { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] } });
    const result = await executeFlow({ context, driver, flow: prepared.flow });
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.steps.filter(step => step.output).map(step => step.output), selected ? ['second'] : ['outer else']);
    assert.equal((await inspectFlowProgress(context.rootDirectory)).completedSteps, 4);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
