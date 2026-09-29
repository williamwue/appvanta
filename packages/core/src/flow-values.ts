import { readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseValueText, type FlowStep } from './flow-schema.js';
import type { ReportStep } from './report.js';

export async function validateExtractedValue(root: string, step: FlowStep, result: ReportStep): Promise<string | undefined> {
  if (!step.extract || result.status === 'skipped') return;
  const path = `value-${result.index}.json`;
  if (result.status !== 'passed' || !result.evidence?.includes(path)) throw new Error('Missing extraction evidence');
  const directory = await realpath(root), target = await realpath(join(directory, path));
  const local = relative(directory, target);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('Value evidence escapes run directory');
  const record = JSON.parse(await readFile(target, 'utf8'));
  const value = parseValueText(record.value);
  if (!isDeepStrictEqual(record, { version: 1, index: result.index, extraction: step.extract, value }) || result.output !== value) throw new Error('Extracted value differs from completed evidence');
  return value;
}

export async function completedValues(root: string, initial: Readonly<Record<string, string>> | undefined,
  completed: readonly { item: { step: FlowStep }; result: ReportStep }[]) {
  const values = new Map(Object.entries(initial ?? {}));
  for (const entry of completed) {
    const value = await validateExtractedValue(root, entry.item.step, entry.result);
    if (value !== undefined) {
      const name = entry.item.step.extract!.name;
      if (values.has(name)) throw new Error('Duplicate extracted value name');
      values.set(name, value);
    }
  }
  return values.size ? { values: Object.fromEntries(values) } : {};
}
