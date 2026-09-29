import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseFlow } from './flow-schema.js';
import { prepareFlowContinuation, prepareAdjudicatedFlowContinuation, previewExecutingFlowProgress } from './flow-progress.js';
import { readContinuationLineage } from './continuation-lineage.js';
import type { TaskInstructionRecord } from './task-instructions.js';
import { TaskStore } from './tasks.js';
import { inspectActiveBranchChoices } from './branch-decision.js';

const digest = (content: Buffer) => ({ sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length });
const requireObject = (value: unknown, name: string): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as Record<string, any>;
};
const readJson = async (path: string, name: string) => {
  try { return requireObject(JSON.parse(await readFile(path, 'utf8')), name); }
  catch (error) { throw new Error(`Missing or invalid ${name}: ${String(error)}`); }
};
const optionalFile = async (path: string): Promise<Buffer | null> => {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};

// Capture every persisted input used by TaskStore and Flow progress, including absent control files.
async function captureInputs(store: TaskStore, sourceTaskId: string, successorTaskId: string,
  sourceRun: string, runDirectory: string): Promise<Record<string, Buffer | null>> {
  const files: Record<string, Buffer | null> = {};
  const capture = async (name: string, path: string) => { files[name] = await optionalFile(path); };
  for (const [label, taskId, root] of [
    ['source', sourceTaskId, sourceRun], ['successor', successorTaskId, runDirectory],
  ] as const) {
    const taskRoot = join(store.directory, taskId);
    for (const name of ['task.json', 'cancel.request', 'pause.request']) await capture(`${label}/${name}`, join(taskRoot, name));
    for (const name of ['flow.json', 'progress.json', 'device.json', 'steps.jsonl']) await capture(`${label}/${name}`, join(root, name));
    const instructionDirectory = join(taskRoot, 'instructions');
    let names: string[];
    try { names = await readdir(instructionDirectory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
    names = names.filter(name => /^instruction-[a-f0-9-]{36}\.json$/.test(name)).sort();
    files[`${label}/instruction-names`] = Buffer.from(JSON.stringify(names));
    for (const name of names) await capture(`${label}/instructions/${name}`, join(instructionDirectory, name));
    const progress = files[`${label}/progress.json`];
    if (progress) {
      const snapshot = requireObject(JSON.parse(progress.toString('utf8')), `${label} progress`);
      if (snapshot.active?.step?.branch) {
        const step = parseFlow({ name: 'Active branch input', steps: [snapshot.active.step] }).steps[0]!;
        for (const selector of [...step.branch!.parents ?? [], step.branch!]) {
          const path = `branch-${selector.key}.json`;
          const file = join(root, path);
          let target;
          try { target = await realpath(file); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (target) {
            const local = relative(root, target);
            if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('Active branch evidence escapes run directory');
          }
          await capture(`${label}/active-branch/${path}`, target ?? file);
        }
      }
      for (const entry of snapshot.completed ?? []) {
        for (const path of entry.result?.evidence ?? []) {
          if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes(':')
            || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid progress evidence path');
          const target = await realpath(resolve(root, path));
          const local = relative(root, target);
          if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\'))
            throw new Error('Progress evidence escapes run directory');
          await capture(`${label}/evidence/${path}`, target);
        }
      }
    }
  }
  const lineage = await readContinuationLineage(store, successorTaskId);
  if (lineage.sourceTaskId !== sourceTaskId) throw new Error('Continuation lineage source changed');
  await capture('source/claim.json', lineage.claimPath);
  await capture('source/successor.json', lineage.successorPath);
  await capture('successor/continuation.json', lineage.markerPath);
  return files;
}

// TaskInstructionStore.list creates its directory. A preview must only read persisted files.
async function readInstructions(store: TaskStore, taskId: string): Promise<TaskInstructionRecord[]> {
  const directory = join(store.directory, taskId, 'instructions');
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: TaskInstructionRecord[] = [];
  for (const name of names.filter(name => /^instruction-[a-f0-9-]{36}\.json$/.test(name))) {
    const value = await readJson(join(directory, name), 'persisted instruction');
    const id = name.slice(0, -5);
    if (value.version !== 1 || value.id !== id || value.taskId !== taskId || typeof value.createdAt !== 'string'
      || !['queued', 'claimed', 'applied', 'failed'].includes(value.status)) throw new Error('Invalid persisted instruction identity or status');
    const step = parseFlow({ version: 1, name: 'Persisted instruction', steps: [value.step] }).steps[0]!;
    records.push({ ...value, step } as TaskInstructionRecord);
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Read-only evidence for one uncertain successor step. The result never authorizes resumption. */
async function evaluatePreview(store: TaskStore, successorTaskId: string) {
  const successor = await store.get(successorTaskId);
  if (successor.status !== 'interrupted') throw new Error(`Uncertain-step preview requires interrupted successor, found ${successor.status}`);
  if (await store.cancellationRequested(successorTaskId)) throw new Error('Successor cancellation is requested');
  if (!successor.runDirectory) throw new Error('Successor has no bound run directory');
  const runDirectory = await realpath(successor.runDirectory);
  const lineage = await readContinuationLineage(store, successorTaskId, successor);
  const sourceTaskId = lineage.sourceTaskId;
  if (typeof sourceTaskId !== 'string' || sourceTaskId === successorTaskId) throw new Error('Invalid continuation source task identity');
  const source = await store.get(sourceTaskId);
  if (source.status !== 'interrupted') throw new Error(`Continuation source is ${source.status}, expected interrupted`);
  if (await store.cancellationRequested(sourceTaskId)) throw new Error('Continuation source cancellation is requested');
  if (!source.runDirectory) throw new Error('Continuation source has no bound run directory');
  const sourceRun = await realpath(source.runDirectory);
  const claim = lineage.claim;
  if (claim.version !== 1 || typeof claim.id !== 'string' || !claim.id
    || claim.sourceTaskId !== sourceTaskId || claim.deviceId !== source.deviceId || claim.deviceId !== successor.deviceId
    || claim.resumeAuthorized !== false || !claim.source || typeof claim.source !== 'object'
    || typeof claim.source.runDirectory !== 'string'
    || await realpath(claim.source.runDirectory) !== sourceRun) throw new Error('Invalid continuation claim lineage');
  const sourceFlow = await readJson(join(sourceRun, 'flow.json'), 'source Flow');
  if (!isDeepStrictEqual(source.flow, sourceFlow) || claim.source.flowSha256 !== digest(Buffer.from(JSON.stringify(sourceFlow))).sha256) throw new Error('Continuation source Flow differs from claim');
  const claimedFlow = parseFlow(claim.flow);
  const checkpoint = claimedFlow.steps[0]?.action;
  if (checkpoint?.kind !== 'wait') throw new Error('Continuation claim has no checkpoint step');
  const prepared = await (lineage.kind === 'ordinary' ? prepareFlowContinuation : prepareAdjudicatedFlowContinuation)(sourceRun, checkpoint.condition,
    await readInstructions(store, sourceTaskId), checkpoint.timeoutMs);
  const sourceDevice = await readJson(join(sourceRun, 'device.json'), 'source device');
  const sourceProgress = await readJson(join(sourceRun, 'progress.json'), 'source progress');
  if (sourceDevice.id !== source.deviceId || sourceProgress.deviceId !== source.deviceId
    || source.deviceId !== claim.deviceId) throw new Error('Source persisted device identity differs from task or claim');
  if (!isDeepStrictEqual(prepared.flow, claim.flow) || !isDeepStrictEqual(prepared.source, claim.source)
    || !isDeepStrictEqual(prepared.stepOrigins, claim.stepOrigins)
    || !isDeepStrictEqual(prepared.omittedResets, claim.omittedResets)) throw new Error('Continuation claim differs from source boundary');
  const runFlow = await readJson(join(runDirectory, 'flow.json'), 'successor Flow');
  const parsedFlow = parseFlow(runFlow);
  if (!isDeepStrictEqual(successor.flow, runFlow) || !isDeepStrictEqual(claim.flow, runFlow)) throw new Error('Successor Flow differs from claim or task');
  if (!Array.isArray(claim.stepOrigins) || claim.stepOrigins.length !== parsedFlow.steps.length - 1
    || claim.stepOrigins.some((origin: unknown, index: number) => {
      const item = requireObject(origin, 'continuation step origin');
      return item.continuationIndex !== index + 1
        || (Number.isSafeInteger(item.flowIndex) && item.flowIndex >= 0) === (typeof item.instructionId === 'string' && !!item.instructionId);
    })) throw new Error('Invalid continuation step origins');
  const progress = await previewExecutingFlowProgress(runDirectory, await readInstructions(store, successorTaskId));
  const successorDevice = await readJson(join(runDirectory, 'device.json'), 'successor device');
  const successorProgress = await readJson(join(runDirectory, 'progress.json'), 'successor progress');
  if (successorDevice.id !== successor.deviceId || successorProgress.deviceId !== successor.deviceId
    || successor.deviceId !== claim.deviceId) throw new Error('Successor persisted device identity differs from task or claim');
  if (progress.active.flowIndex !== undefined && !isDeepStrictEqual(progress.active.step, parsedFlow.steps[progress.active.flowIndex])) throw new Error('Active step differs from successor Flow');
  const activeOrigin = progress.active.flowIndex === undefined || progress.active.flowIndex === 0
    ? undefined : claim.stepOrigins[progress.active.flowIndex - 1];
  return { sourceRun, sourceTaskId, runDirectory, preview: { version: 1 as const, sourceTaskId, successorTaskId, runDirectory, phase: progress.phase,
    revision: progress.revision, activeStepIndex: progress.activeStepIndex,
    activeStep: progress.active.step, activeIdentity: progress.active.flowIndex !== undefined
      ? { flowIndex: progress.active.flowIndex } : { instructionId: progress.active.instructionId },
    ...(activeOrigin ? { sourceOrigin: activeOrigin } : {}),
    completedSteps: progress.completedSteps, completedEvidenceSha256: progress.completedEvidenceSha256,
    ...(progress.active.step.branch ? { activeBranches: await inspectActiveBranchChoices(runDirectory, progress.active.step) } : {}),
    resumeAuthorized: false as const } };
}

/** Read-only evidence for one uncertain successor step. The result never authorizes resumption.
 * Stable rereads reject observed races; independent filesystem reads are not an atomic transaction,
 * so changes after the final capture or an undetected ABA replacement remain possible.
 */
export async function previewUncertainTaskStep(store: TaskStore, successorTaskId: string) {
  const first = await evaluatePreview(store, successorTaskId);
  const before = await captureInputs(store, first.sourceTaskId, successorTaskId, first.sourceRun, first.runDirectory);
  const second = await evaluatePreview(store, successorTaskId);
  const after = await captureInputs(store, second.sourceTaskId, successorTaskId, second.sourceRun, second.runDirectory);
  if (!isDeepStrictEqual(first, second) || !isDeepStrictEqual(before, after))
    throw new Error('Uncertain-step preview inputs changed during read');
  const evidenceSha256: Record<string, { sha256: string; bytes: number }> = {};
  for (const [name, key] of Object.entries({
    sourceClaim: 'source/claim.json', sourceSuccessor: 'source/successor.json',
    successorContinuation: 'successor/continuation.json', successorFlow: 'successor/flow.json',
    successorProgress: 'successor/progress.json', successorSteps: 'successor/steps.jsonl',
    sourceTask: 'source/task.json', successorTask: 'successor/task.json',
  })) {
    const content = before[key];
    if (!content && (name !== 'successorSteps' || second.preview.completedSteps))
      throw new Error(`Missing preview evidence: ${name}`);
    evidenceSha256[name] = digest(content ?? Buffer.alloc(0));
  }
  // Null is distinct from an empty file. Include canonical roots as well as every
  // captured byte so the digest cannot silently rebind identical files to a new run.
  const inputs = Object.keys(before).sort().map(name => [name, before[name] === null ? null : digest(before[name]!)]);
  const previewDigestSha256 = createHash('sha256').update(JSON.stringify({
    sourceTaskId: second.sourceTaskId, successorTaskId, sourceRun: second.sourceRun,
    runDirectory: second.runDirectory, inputs,
  })).digest('hex');
  return { ...second.preview, sourceRun: second.sourceRun, evidenceSha256, previewDigestSha256 };
}
