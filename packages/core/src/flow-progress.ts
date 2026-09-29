import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseFlow, parseCondition, type FlowStep } from './flow-schema.js';
import { validateCompletedCondition } from './step-condition.js';
import { freezeCompletedBranches, inspectActiveBranchChoices } from './branch-decision.js';
import type { TaskInstructionRecord } from './task-instructions.js';

export type ProgressEvidenceHashes = Record<string, { sha256: string; bytes: number }>;
export async function fingerprintProgressEvidence(root: string, paths: readonly string[], expected?: ProgressEvidenceHashes): Promise<ProgressEvidenceHashes> {
  const directory = await realpath(root);
  const hashes: ProgressEvidenceHashes = Object.create(null);
  for (const path of paths) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid progress evidence path');
    const target = await realpath(resolve(directory, path));
    const local = relative(directory, target);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('Progress evidence escapes run directory');
    let content = await readFile(target);
    if (expected && path === 'recovery.jsonl') {
      const bytes = expected[path]?.bytes;
      if (!Number.isSafeInteger(bytes) || bytes! < 0 || bytes! > content.length) throw new Error('Invalid recovery evidence prefix length');
      content = content.subarray(0, bytes);
    }
    hashes[path] = { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length };
  }
  return hashes;
}

/** Inspects persisted execution only; device recovery and live checkpoint validation remain mandatory. */
async function readValidatedProgress(root: string, instructions?: readonly TaskInstructionRecord[]) {
  const original = JSON.parse(await readFile(join(root, 'flow.json'), 'utf8'));
  const flow = parseFlow(original);
  const snapshot = JSON.parse(await readFile(join(root, 'progress.json'), 'utf8'));
  const device = JSON.parse(await readFile(join(root, 'device.json'), 'utf8'));
  if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
    || snapshot.deviceId !== device.id || !Array.isArray(snapshot.completed) || !Array.isArray(snapshot.pending)
    || !['setup', 'boundary', 'executing', 'finalizing', 'finished'].includes(snapshot.phase)) throw new Error('Invalid Flow progress snapshot');
  if (snapshot.flowSha256 !== createHash('sha256').update(JSON.stringify(original)).digest('hex')) throw new Error('Flow definition changed since progress was saved');
  let rawSteps = '';
  try { rawSteps = await readFile(join(root, 'steps.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const steps = rawSteps.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const originalIndices: number[] = [];
  const instructionIds = new Set<string>();
  const instructionItems = new Map<string, { step: unknown; completed: boolean }>();
  const inspectItem = (item: any) => {
    if (!item || !item.step || (item.flowIndex === undefined) === (item.instructionId === undefined)) throw new Error('Ambiguous progress step identity');
    parseFlow({ name: 'Progress item', steps: [item.step] });
    if (item.flowIndex !== undefined) {
      if (!Number.isSafeInteger(item.flowIndex) || item.flowIndex < 0 || item.flowIndex >= flow.steps.length
        || !isDeepStrictEqual(item.step, original.steps[item.flowIndex])) throw new Error('Progress step differs from original Flow');
      originalIndices.push(item.flowIndex);
    } else {
      if (typeof item.instructionId !== 'string' || !item.instructionId || instructionIds.has(item.instructionId)) throw new Error('Invalid or duplicate instruction identity');
      instructionIds.add(item.instructionId);
      instructionItems.set(item.instructionId, { step: item.step, completed: false });
    }
  };
  for (const [index, entry] of snapshot.completed.entries()) {
    inspectItem(entry?.item);
    if (entry.item.instructionId) instructionItems.get(entry.item.instructionId)!.completed = true;
    if (!['passed', 'skipped'].includes(entry.result?.status) || entry.result.index !== index + 1 || !isDeepStrictEqual(entry.result, steps[index])) throw new Error('Completed progress does not match passed/skipped step evidence');
    await validateCompletedCondition(root, entry.item.step, entry.result);
    if (!Array.isArray(entry.result.evidence)) throw new Error('Missing completed step evidence');
    const actual = await fingerprintProgressEvidence(root, entry.result.evidence, entry.evidenceSha256);
    if (!entry.evidenceSha256 || !isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), entry.evidenceSha256)) throw new Error('Progress evidence hash mismatch');
  }
  if (snapshot.active !== undefined) inspectItem(snapshot.active);
  snapshot.pending.forEach(inspectItem);
  if (!isDeepStrictEqual(originalIndices, flow.steps.map((_, index) => index))) throw new Error('Progress lost, duplicated or reordered original steps');
  const reasons: string[] = [];
  if (snapshot.phase !== 'boundary') reasons.push(`phase-${snapshot.phase}`);
  if (steps.length !== snapshot.completed.length) reasons.push('step-log-ahead-of-progress');
  if (instructions === undefined) {
    if (instructionIds.size) reasons.push('instruction-store-reconciliation-required');
  } else {
    const seen = new Set<string>();
    for (const record of instructions) {
      if (seen.has(record.id)) throw new Error('Duplicate persisted instruction');
      seen.add(record.id);
      const item = instructionItems.get(record.id);
      if (!item) {
        if (record.status !== 'queued') reasons.push(`instruction-unaccounted:${record.id}`);
      } else {
        if (!isDeepStrictEqual(item.step, record.step)) throw new Error('Instruction differs from progress');
        if (record.status !== (item.completed ? 'applied' : 'claimed')) reasons.push(`instruction-status-conflict:${record.id}`);
      }
    }
    for (const id of instructionIds) if (!seen.has(id)) reasons.push(`instruction-missing:${id}`);
  }
  const inspection = { version: 1, deviceId: snapshot.deviceId, phase: snapshot.phase, revision: snapshot.revision,
    completedSteps: snapshot.completed.length, remainingSteps: snapshot.pending.length + (snapshot.active ? 1 : 0),
    boundaryConsistent: reasons.length === 0, reasons, resumeAuthorized: false,
    requiredChecks: ['owner-and-device-lease', 'resource-recovery', 'evidence-integrity', 'instruction-store-reconciliation', 'live-checkpoint'] };
  return { inspection, flow, snapshot };
}

export async function inspectFlowProgress(root: string, instructions?: readonly TaskInstructionRecord[]) {
  return (await readValidatedProgress(root, instructions)).inspection;
}

/** Describes an executing snapshot for human review; it never selects a retry or skip. */
export async function previewExecutingFlowProgress(root: string, instructions: readonly TaskInstructionRecord[]) {
  const { inspection, snapshot } = await readValidatedProgress(root, instructions);
  if (inspection.phase !== 'executing') throw new Error(`Uncertain-step preview requires executing phase, found ${inspection.phase}`);
  if (!snapshot.active || inspection.remainingSteps < 1) throw new Error('Executing progress has no single active step');
  const conflicts = inspection.reasons.filter(reason => reason !== 'phase-executing');
  if (conflicts.length) throw new Error(`Uncertain-step preview has conflicting progress: ${conflicts.join(', ')}`);
  if (snapshot.status !== undefined) throw new Error('Executing progress has an unexpected terminal status');
  const active = snapshot.active as { step: FlowStep; flowIndex?: number; instructionId?: string };
  return { phase: 'executing' as const, revision: inspection.revision, completedSteps: inspection.completedSteps,
    activeStepIndex: inspection.completedSteps + 1, active,
    completedEvidenceSha256: snapshot.completed.map((entry: { evidenceSha256: ProgressEvidenceHashes }) => entry.evidenceSha256),
    resumeAuthorized: false as const };
}

export async function prepareFlowContinuation(root: string, checkpoint: unknown, instructions: readonly TaskInstructionRecord[] = [], timeoutMs = 10000) {
  const { inspection, flow, snapshot } = await readValidatedProgress(root, instructions);
  if (!inspection.boundaryConsistent) throw new Error(`Unsafe continuation boundary: ${inspection.reasons.join(', ')}`);
  const condition = parseCondition(checkpoint);
  if (condition.kind === 'ui-changed' || condition.kind === 'screen-stable') throw new Error('Continuation requires a checkpoint describing expected application state');
  const remaining: { step: FlowStep; flowIndex?: number; instructionId?: string }[] = [
    ...(snapshot.active ? [snapshot.active] : []), ...snapshot.pending,
  ];
  const queued = instructions.filter(item => item.status === 'queued');
  remaining.splice(snapshot.active ? 1 : 0, 0, ...queued.map(item => ({ step: item.step, instructionId: item.id })));
  if (!remaining.length) throw new Error('No remaining steps to continue');
  const { resetApplications: omittedResets, steps: _steps, ...configuration } = flow;
  const continuation = parseFlow({ ...configuration, name: `Continue: ${flow.name}`, steps: [
    { description: 'Verify continuation checkpoint', action: { kind: 'wait', condition, timeoutMs } },
    ...await freezeCompletedBranches(root, snapshot.completed, remaining.map(item => item.step)),
  ] });
  return { flow: continuation, source: { runDirectory: await realpath(root), revision: inspection.revision,
    flowSha256: snapshot.flowSha256 as string, completedSteps: inspection.completedSteps },
    omittedResets: omittedResets ?? [],
    stepOrigins: remaining.map((item, index) => ({ continuationIndex: index + 1,
      ...(item.flowIndex !== undefined ? { flowIndex: item.flowIndex } : { instructionId: item.instructionId }) })),
    resumeAuthorized: false };
}

/** A proposed flow only: the skipped executing step still requires a fresh, guarded live checkpoint. */
export async function prepareAdjudicatedFlowContinuation(root: string, checkpoint: unknown,
  instructions: readonly TaskInstructionRecord[] = [], timeoutMs = 10000) {
  const { inspection, flow, snapshot } = await readValidatedProgress(root, instructions);
  if (inspection.phase !== 'executing' || !snapshot.active ||
    inspection.reasons.some(reason => reason !== 'phase-executing'))
    throw new Error(`Unsafe adjudicated continuation: ${inspection.reasons.join(', ')}`);
  const condition = parseCondition(checkpoint);
  if (condition.kind === 'ui-changed' || condition.kind === 'screen-stable')
    throw new Error('Continuation requires a checkpoint describing expected application state');
  const remaining: { step: FlowStep; flowIndex?: number; instructionId?: string }[] = [
    ...instructions.filter(item => item.status === 'queued').map(item => ({ step: item.step, instructionId: item.id })),
    ...snapshot.pending,
  ];
  const { resetApplications: omittedResets, steps: _steps, ...configuration } = flow;
  const activeBranches = await inspectActiveBranchChoices(root, snapshot.active.step);
  if (activeBranches.selected === undefined) throw new Error('Cannot adjudicate an unfinished initial branch decision; its remaining choice is not verified');
  const continuation = parseFlow({ ...configuration, name: `Continue after adjudication: ${flow.name}`, steps: [
    { description: 'Verify adjudicated postcondition on live device', action: { kind: 'wait', condition, timeoutMs } },
    ...await freezeCompletedBranches(root, snapshot.completed, remaining.map(item => item.step), activeBranches.choices.map(choice => [choice.decision.key, choice.decision.matched] as const)),
  ] });
  return { flow: continuation, source: { runDirectory: await realpath(root), revision: inspection.revision,
    flowSha256: snapshot.flowSha256 as string, completedSteps: inspection.completedSteps,
    ...(snapshot.active.step.branch ? { activeBranchEvidenceSha256: Object.fromEntries(activeBranches.choices.map(choice => [choice.path, { sha256: choice.sha256, bytes: choice.bytes }])) } : {}),
    skippedStepIndex: inspection.completedSteps + 1, completedEvidenceSha256: snapshot.completed.map(
      (entry: { evidenceSha256: ProgressEvidenceHashes }) => entry.evidenceSha256) },
    omittedResets: omittedResets ?? [],
    stepOrigins: remaining.map((item, index) => ({ continuationIndex: index + 1,
      ...(item.flowIndex !== undefined ? { flowIndex: item.flowIndex } : { instructionId: item.instructionId }) })),
    resumeAuthorized: false as const };
}
