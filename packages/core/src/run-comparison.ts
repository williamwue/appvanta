import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFlow } from './flow-schema.js';
import { recordedFlow } from './recording.js';
import { createHash } from 'node:crypto';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
};
export async function compareRunMetadata(baseline: string, current: string): Promise<string[]> {
  const differences: string[] = [];
  const load = async (root: string) => {
    const json = async (file: string) => JSON.parse(await readFile(join(root, file), 'utf8'));
    const run = await json('run.json');
    if (!run || typeof run.runId !== 'string' || !run.runId || typeof run.driver !== 'string' || !run.driver
      || run.status !== 'passed' || typeof run.startedAt !== 'string' || typeof run.finishedAt !== 'string'
      || !Number.isFinite(Date.parse(run.startedAt)) || !Number.isFinite(Date.parse(run.finishedAt)) || Date.parse(run.finishedAt) < Date.parse(run.startedAt)) throw new Error('Invalid or incomplete passing run metadata');
    const device = await json('device.json');
    for (const key of ['platform', 'kind', 'model', 'osVersion']) if (!device || typeof device[key] !== 'string' || !device[key]) throw new Error(`Missing device environment: ${key}`);
    const flow = parseFlow(await json('flow.json'));
    const environmentBytes = await readFile(join(root, 'environment.json'));
    if (createHash('sha256').update(environmentBytes).digest('hex') !== run.recording?.['environment.json']) throw new Error('Environment evidence integrity mismatch');
    const environment = JSON.parse(environmentBytes.toString('utf8'));
    if (environment?.version !== 1 || environment.scope !== 'declared-applications' || !environment.host || !Array.isArray(environment.applications) || !environment.applications.length) throw new Error('Missing application/tool environment');
    for (const key of ['node', 'adb', 'platform', 'arch', 'runtimeSha256']) if (typeof environment.host[key] !== 'string' || !environment.host[key]) throw new Error(`Missing host tool: ${key}`);
    if (!/^[a-f0-9]{64}$/.test(environment.host.runtimeSha256)) throw new Error('Invalid runtime fingerprint');
    const validUser = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
    const ime = environment.inputMethod;
    if (ime !== undefined && (!ime || !validUser(ime.userId) || typeof ime.selected !== 'string' || !Array.isArray(ime.enabled) || !ime.enabled.every((value: unknown) => typeof value === 'string') || new Set(ime.enabled).size !== ime.enabled.length)) throw new Error('Invalid input method environment');
    if (flow.inputMethod && ime === undefined) throw new Error('Missing input method environment');
    const fields = ['files', 'appOps', 'permissions'] as const;
    for (const field of fields) {
      const entries = environment[field];
      if (entries === undefined) {
        if (flow[field]?.length) throw new Error(`Missing ${field} environment`);
        continue;
      }
      if (!Array.isArray(entries)) throw new Error(`Invalid ${field} environment`);
      const seen = new Set();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') throw new Error(`Invalid ${field} entry`);
        const key = field === 'files' ? entry.path : `${entry.packageName}/${field === 'appOps' ? entry.operation : entry.permission}`;
        if (seen.has(key)) throw new Error(`Duplicate ${field} entry`);
        seen.add(key);
        if (field === 'files') {
          if (typeof entry.path !== 'string' || !entry.path.startsWith('/') || typeof entry.exists !== 'boolean' || (entry.exists ? !/^[a-f0-9]{64}$/.test(entry.sha256) : entry.sha256 !== undefined)) throw new Error('Invalid file fingerprint');
        } else {
          if (!validUser(entry.userId) || typeof entry.packageName !== 'string' || !/^[\w.]+$/.test(entry.packageName)) throw new Error(`Invalid ${field} identity`);
          if (field === 'appOps' ? !/^[A-Z][A-Z0-9_]*$/.test(entry.operation) || !['allow', 'ignore', 'deny', 'default'].includes(entry.mode) : typeof entry.permission !== 'string' || typeof entry.granted !== 'boolean' || !Array.isArray(entry.flags) || !entry.flags.every((value: unknown) => typeof value === 'string')) throw new Error(`Invalid ${field} state`);
        }
      }
      for (const fixture of flow[field] ?? []) {
        const value = fixture as unknown as Record<string, string>;
        const key = field === 'files' ? value.path : `${value.packageName}/${field === 'appOps' ? value.operation : value.permission}`;
        if (!seen.has(key)) throw new Error(`Missing declared ${field} entry`);
      }
    }
    const names = new Set();
    for (const app of environment.applications) {
      if (!app || typeof app.packageName !== 'string' || !/^[A-Za-z0-9_.]+$/.test(app.packageName) || names.has(app.packageName)
        || typeof app.installed !== 'boolean' || !Array.isArray(app.apks) || (app.installed ? !app.apks.length : app.apks.length !== 0)) throw new Error('Invalid application identity');
      names.add(app.packageName);
      for (const apk of app.apks) if (!apk || typeof apk.name !== 'string' || !apk.name.endsWith('.apk') || !/^[a-f0-9]{64}$/.test(apk.sha256)) throw new Error('Invalid APK fingerprint');
    }
    const recording = await recordedFlow(root);
    const report = await json('report.json');
    const steps = (await readFile(join(root, 'steps.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (canonical(report?.metadata) !== canonical(run) || canonical(report?.steps) !== canonical(steps)) throw new Error('Report disagrees with run or step evidence');
    return { run, device, flow, recording, environment };
  };
  let before, after;
  try { before = await load(baseline); } catch (error) { differences.push(`Baseline metadata: ${String(error)}`); }
  try { after = await load(current); } catch (error) { differences.push(`Current metadata: ${String(error)}`); }
  if (!before || !after) return differences;
  if (before.run.driver !== after.run.driver) differences.push('Driver changed');
  for (const key of ['platform', 'kind', 'model', 'osVersion']) if (before.device[key] !== after.device[key]) differences.push(`Device environment changed: ${key}`);
  const execution = ({ name, description, ...rest }: typeof before.flow) => rest;
  if (canonical(execution(before.flow)) !== canonical(execution(after.flow))) differences.push('Flow execution definition changed (actions, targets, checkpoints or resource configuration)');
  if (canonical(before.environment.applications) !== canonical(after.environment.applications)) differences.push('Installed application builds changed');
  if (canonical(before.environment.host) !== canonical(after.environment.host)) differences.push('Host tools or executable runtime changed');
  for (const [field, label] of [['inputMethod', 'Input method'], ['files', 'Declared file contents'], ['appOps', 'AppOps'], ['permissions', 'Runtime permissions']]) {
    if (canonical(before.environment[field!]) !== canonical(after.environment[field!])) differences.push(`${label} environment changed`);
  }
  if (canonical(before.recording.steps) !== canonical(after.recording.steps)) differences.push('Actual executed operation sequence changed');
  return differences;
}
