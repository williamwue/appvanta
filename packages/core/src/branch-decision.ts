import { open, readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FlowStep, BranchSelector } from './flow-schema.js';
import type { ReportStep } from './report.js';

type Branch = NonNullable<FlowStep['branch']>;
type Decision = { version: 1; key: string; condition: Branch['when']; matched: boolean; source: 'observed' | 'resolved' };
async function readDecision(root: string, branch: BranchSelector) {
  const path = `branch-${branch.key}.json`, directory = await realpath(root), target = await realpath(join(directory, path));
  const local = relative(directory, target);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('Branch evidence escapes run directory');
  const bytes = await readFile(target), decision = JSON.parse(bytes.toString('utf8'));
  if (typeof decision?.matched !== 'boolean' || !isDeepStrictEqual(decision, { version: 1, key: branch.key, condition: branch.when, matched: decision.matched,
    source: branch.resolved === undefined ? 'observed' : 'resolved' }) || (branch.resolved !== undefined && branch.resolved !== decision.matched)) throw new Error('Branch evidence does not match step');
  return { path, decision: decision as Decision, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/** Read-only: records a missing reachable decision without inventing its value. */
export async function inspectActiveBranchChoices(root: string, step: FlowStep) {
  const choices: Awaited<ReturnType<typeof readDecision>>[] = [];
  if (!step.branch) return { choices, selected: true as boolean | undefined };
  for (const selector of [...step.branch.parents ?? [], step.branch]) {
    let choice;
    try { choice = await readDecision(root, selector); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { choices, selected: undefined, missingKey: selector.key };
      throw error;
    }
    choices.push(choice);
    if (choice.decision.matched !== selector.equals) return { choices, selected: false };
  }
  return { choices, selected: true };
}
export class BranchDecisions {
  private readonly decisions = new Map<string, Decision>();
  private readonly signatures = new Map<string, string>();
  constructor(private readonly root: string) {}
  async choose(branch: Branch, evaluate: (condition: BranchSelector['when']) => Promise<boolean>) {
    const paths: string[] = [];
    const chain = [...branch.parents ?? [], branch];
    for (const [index, selector] of chain.entries()) {
      const signature = JSON.stringify({ when: selector.when, resolved: selector.resolved, parents: chain.slice(0, index).map(parent => ({ key: parent.key, equals: parent.equals })) });
      if (this.signatures.has(selector.key) && this.signatures.get(selector.key) !== signature) throw new Error('Branch ancestry or definition changed during execution');
      this.signatures.set(selector.key, signature);
      const decision = await this.chooseOne(selector, () => evaluate(selector.when));
      paths.push(decision.path);
      if (!decision.matched) return { matched: false, paths };
    }
    return { matched: true, paths };
  }
  private async chooseOne(branch: BranchSelector, evaluate: () => Promise<boolean>) {
    let decision = this.decisions.get(branch.key);
    const path = `branch-${branch.key}.json`;
    if (decision) {
      if (!isDeepStrictEqual(decision.condition, branch.when) || (branch.resolved !== undefined && decision.matched !== branch.resolved)) throw new Error('Branch definition changed during execution');
    } else {
      const matched = branch.resolved ?? await evaluate();
      if (typeof matched !== 'boolean') throw new Error('Branch driver must return a boolean');
      decision = { version: 1, key: branch.key, condition: branch.when, matched, source: branch.resolved === undefined ? 'observed' : 'resolved' };
      const file = await open(join(this.root, path), 'wx');
      try { await file.writeFile(JSON.stringify(decision, null, 2)); await file.sync(); }
      finally { await file.close(); }
      this.decisions.set(branch.key, decision);
    }
    return { matched: decision.matched === branch.equals, path };
  }
}

export async function validateCompletedBranch(root: string, step: FlowStep, result: ReportStep): Promise<Map<string, boolean>> {
  const verified = new Map<string, boolean>();
  if (!step.branch) {
    if (result.branchMatched !== undefined) throw new Error('Unexpected branch result');
    return verified;
  }
  let selected = true;
  for (const branch of [...step.branch.parents ?? [], step.branch]) {
    const path = `branch-${branch.key}.json`;
    if (typeof result.branchMatched !== 'boolean' || !result.evidence?.includes(path)) throw new Error('Missing branch evidence');
    const { decision } = await readDecision(root, branch);
    verified.set(branch.key, decision.matched);
    if (decision.matched !== branch.equals) { selected = false; break; }
  }
  if (result.branchMatched !== selected) throw new Error('Branch selection does not match completed step');
  if (!result.branchMatched && (result.status !== 'skipped' || result.conditionMatched !== undefined)) throw new Error('Unselected branch performed a step condition');
  return verified;
}

export async function freezeCompletedBranches(root: string, completed: readonly { item: { step: FlowStep }; result: ReportStep }[], remaining: readonly FlowStep[], activeChoices: readonly (readonly [string, boolean])[] = []) {
  const decisions = new Map<string, boolean>(activeChoices);
  for (const entry of completed) {
    for (const [key, matched] of await validateCompletedBranch(root, entry.item.step, entry.result)) {
      if (decisions.has(key) && decisions.get(key) !== matched) throw new Error('Active branch differs from completed evidence');
      decisions.set(key, matched);
    }
  }
  const freeze = (selector: BranchSelector) => decisions.has(selector.key) ? { ...selector, resolved: decisions.get(selector.key)! } : selector;
  return remaining.map(step => step.branch ? { ...step, branch: { ...freeze(step.branch),
    ...(step.branch.parents ? { parents: step.branch.parents.map(freeze) } : {}) } } : step);
}
