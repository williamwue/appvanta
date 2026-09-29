import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowDriver } from './flow.js';
import { parseFlow } from './flow-schema.js';
import type { FlowStep } from './flow-schema.js';
import { validateCompletedCondition } from './step-condition.js';

export async function recordingDriver(driver: FlowDriver, root: string, step: () => number): Promise<FlowDriver> {
  const path = join(root, 'actions.jsonl');
  await writeFile(path, '', { flag: 'wx' });
  let sequence = 0;
  const append = (value: object) => writeFile(path, JSON.stringify({ version: 1, timestamp: new Date().toISOString(), ...value }) + '\n', { flag: 'a' });
  return new Proxy(driver, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const key = property === 'execute' ? 'action' : property === 'launch' ? 'launchPackage' : property === 'openUrl' ? 'openUrl' : undefined;
      if (!key) return value.bind(target);
      return async (...args: unknown[]) => {
        const id = ++sequence;
        const record = { id, step: step(), operation: { [key]: args[1] } };
        await append({ ...record, phase: 'started' });
        try {
          const result = await value.apply(target, args);
          await append({ id, step: record.step, phase: 'finished', status: result?.success === false ? 'failed' : 'passed' });
          return result;
        } catch (error) {
          await append({ id, step: record.step, phase: 'finished', status: 'failed', message: String(error) });
          throw error;
        }
      };
    },
  });
}

/** Compile actual acknowledged operations; never invent actions from descriptions. */
export async function recordedFlow(root: string) {
  const run = JSON.parse(await readFile(join(root, 'run.json'), 'utf8'));
  if (run.status !== 'passed') throw new Error('Only completed passing runs can be recorded for replay');
  for (const name of ['actions.jsonl', 'flow.json', 'steps.jsonl']) {
    const hash = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
    if (run.recording?.[name] !== hash) throw new Error(`Missing or mismatched recording integrity: ${name}`);
  }
  const source = parseFlow(JSON.parse(await readFile(join(root, 'flow.json'), 'utf8')));
  const records = (await readFile(join(root, 'steps.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (records.length !== source.steps.length || records.some((r, i) => r.index !== i + 1 || !['passed', 'skipped'].includes(r.status) || r.description !== source.steps[i]?.description)) throw new Error('Step evidence does not match completed Flow');
  for (const [index, record] of records.entries()) await validateCompletedCondition(root, source.steps[index]!, record);
  const lines = (await readFile(join(root, 'actions.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const operations = new Map<number, FlowStep[]>();
  let lastStep = 1;
  for (let i = 0; i < lines.length; i += 2) {
    const start = lines[i], end = lines[i + 1];
    if (start.version !== 1 || start.phase !== 'started' || start.id !== i / 2 + 1 || !Number.isInteger(start.step) || start.step < lastStep || start.step > source.steps.length
      || !end || end.version !== 1 || end.phase !== 'finished' || end.id !== start.id || end.step !== start.step || end.status !== 'passed') throw new Error('Incomplete, failed or out-of-order action recording');
    lastStep = start.step;
    if (!start.operation || Object.keys(start.operation).length !== 1 || !['action', 'launchPackage', 'openUrl'].includes(Object.keys(start.operation)[0]!)) throw new Error('Invalid recorded operation');
    const operation = parseFlow({ name: 'recorded operation', steps: [{ description: source.steps[start.step - 1]!.description, ...start.operation }] }).steps[0]!;
    const list = operations.get(start.step) ?? [];
    list.push(operation); operations.set(start.step, list);
  }
  const steps: FlowStep[] = [];
  for (const [index, definition] of source.steps.entries()) {
    const actual = operations.get(index + 1) ?? [];
    if (records[index].status === 'skipped') {
      if (actual.length) throw new Error('Skipped conditional step has recorded operations');
      steps.push({ description: definition.description, echo: 'Originally skipped because its condition was false; no operation replayed.' });
      continue;
    }
    if (!actual.length && (definition.action || definition.inputValue || definition.launchPackage || definition.openUrl)) throw new Error('Missing action recording for executed step');
    steps.push(...actual);
    if (definition.extract) steps.push({ description: definition.description, echo: 'Previously extracted value; recorded inputs retain the observed text.' });
    if (definition.echo) steps.push({ description: definition.description, echo: definition.echo });
    const { assertText, assertTarget, timeoutMs } = definition;
    if (assertText || assertTarget) steps.push({ description: `${definition.description} — checkpoint`, ...(assertText ? { assertText } : {}), ...(assertTarget ? { assertTarget } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
  }
  return parseFlow({ version: 1, name: `Recorded: ${source.name}`, description: `Actual operations from run ${run.runId}. Review input data and device state before replay.`, ...(source.appOps ? { appOps: source.appOps } : {}), ...(source.permissions ? { permissions: source.permissions } : {}), ...(source.inputMethod ? { inputMethod: source.inputMethod } : {}), ...(source.files ? { files: source.files } : {}), ...(source.applications ? { applications: source.applications } : {}), ...(source.resetApplications ? { resetApplications: source.resetApplications } : {}), ...(source.network ? { network: source.network } : {}), ...(source.capture ? { capture: source.capture } : {}), ...(source.diagnostics ? { diagnostics: source.diagnostics } : {}), steps });
}
