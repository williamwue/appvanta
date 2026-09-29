import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { FlowStep } from './flow-schema.js';
import type { ReportStep } from './report.js';
import { validateCompletedBranch } from './branch-decision.js';

export async function validateCompletedCondition(root: string, step: FlowStep, result: ReportStep): Promise<void> {
  await validateCompletedBranch(root, step, result);
  if (step.branch && result.branchMatched === false) return;
  if (!step.when) {
    if (result.status === 'skipped' || result.conditionMatched !== undefined) throw new Error('Unexpected condition decision on unconditional step');
    return;
  }
  const path = `condition-${result.index}.json`;
  if (typeof result.conditionMatched !== 'boolean' || !result.evidence?.includes(path)
    || result.status !== (result.conditionMatched ? 'passed' : 'skipped')) throw new Error('Invalid completed condition decision');
  const decision = JSON.parse(await readFile(join(root, path), 'utf8'));
  if (!isDeepStrictEqual(decision, { version: 1, index: result.index, condition: step.when, matched: result.conditionMatched })) throw new Error('Condition evidence does not match completed step');
}
