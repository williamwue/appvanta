import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { FlowStep } from './flow-schema.js';
import type { ReportStep } from './report.js';

type Branch = NonNullable<FlowStep['branch']>;
type Decision = { version: 1; key: string; condition: Branch['when']; matched: boolean; source: 'observed' | 'resolved' };
export class BranchDecisions {
  private readonly decisions = new Map<string, Decision>();
  constructor(private readonly root: string) {}
  async choose(branch: Branch, evaluate: () => Promise<boolean>) {
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

export async function validateCompletedBranch(root: string, step: FlowStep, result: ReportStep): Promise<boolean | undefined> {
  if (!step.branch) {
    if (result.branchMatched !== undefined) throw new Error('Unexpected branch result');
    return;
  }
  const branch = step.branch, path = `branch-${branch.key}.json`;
  if (typeof result.branchMatched !== 'boolean' || !result.evidence?.includes(path)) throw new Error('Missing branch evidence');
  const decision = JSON.parse(await readFile(join(root, path), 'utf8'));
  if (typeof decision.matched !== 'boolean' || !isDeepStrictEqual(decision, { version: 1, key: branch.key, condition: branch.when, matched: decision.matched,
    source: branch.resolved === undefined ? 'observed' : 'resolved' }) || (branch.resolved !== undefined && branch.resolved !== decision.matched)
    || result.branchMatched !== (decision.matched === branch.equals)) throw new Error('Branch evidence does not match completed step');
  if (!result.branchMatched && (result.status !== 'skipped' || result.conditionMatched !== undefined)) throw new Error('Unselected branch performed a step condition');
  return decision.matched;
}

export async function freezeCompletedBranches(root: string, completed: readonly { item: { step: FlowStep }; result: ReportStep }[], remaining: readonly FlowStep[]) {
  const decisions = new Map<string, boolean>();
  for (const entry of completed) {
    const matched = await validateCompletedBranch(root, entry.item.step, entry.result);
    if (matched !== undefined) decisions.set(entry.item.step.branch!.key, matched);
  }
  return remaining.map(step => step.branch && decisions.has(step.branch.key)
    ? { ...step, branch: { ...step.branch, resolved: decisions.get(step.branch.key)! } } : step);
}
