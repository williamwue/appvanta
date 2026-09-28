export interface PerformanceContext {
  platform: string; deviceModel: string; osVersion: string; appId: string;
  scenario: string; collector: string; collectorVersion: string;
  sampling: { durationMs: number; iterations: number; warmupIterations: number; aggregation: 'mean' | 'median' | 'p95' | 'max' | 'single' };
}
type Unit = 'ms' | 'ns' | 'bytes' | 'percent' | 'count' | 'fps';
export interface PerformanceDocument {
  version: 2;
  kind: 'baseline' | 'measurement';
  context: PerformanceContext;
  metrics: Record<string, { unit: Unit; value?: number; min?: number; max?: number }>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}`);
};
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function parsePerformanceDocument(value: unknown, kind: PerformanceDocument['kind']): PerformanceDocument {
  const doc = object(value); keys(doc, ['version', 'kind', 'context', 'metrics']);
  if (doc.version !== 2 || doc.kind !== kind) throw new Error(`Expected version 2 ${kind}`);
  const context = object(doc.context);
  const fields = ['platform', 'deviceModel', 'osVersion', 'appId', 'scenario', 'collector', 'collectorVersion'];
  keys(context, [...fields, 'sampling']);
  for (const key of fields) if (typeof context[key] !== 'string' || !(context[key] as string).trim()) throw new Error(`Missing context: ${key}`);
  const sampling = object(context.sampling); keys(sampling, ['durationMs', 'iterations', 'warmupIterations', 'aggregation']);
  for (const key of ['durationMs', 'iterations', 'warmupIterations']) if (!numeric(sampling[key]) || !Number.isSafeInteger(sampling[key])) throw new Error(`Invalid sampling: ${key}`);
  if ((sampling.iterations as number) < 1 || (typeof sampling.aggregation !== 'string' || !['mean', 'median', 'p95', 'max', 'single'].includes(sampling.aggregation))) throw new Error('Invalid sample count or aggregation');
  if (sampling.aggregation === 'single' && sampling.iterations !== 1) throw new Error('Single aggregation requires one sample');
  const metrics = object(doc.metrics);
  if (!Object.keys(metrics).length) throw new Error('Metrics must not be empty');
  for (const [name, entry] of Object.entries(metrics)) {
    if (!name.trim()) throw new Error('Empty metric name');
    const metric = object(entry); keys(metric, kind === 'baseline' ? ['unit', 'min', 'max'] : ['unit', 'value']);
    if (typeof metric.unit !== 'string' || !['ms', 'ns', 'bytes', 'percent', 'count', 'fps'].includes(metric.unit)) throw new Error(`Unknown unit: ${name}`);
    const values = kind === 'baseline' ? ['min', 'max'].filter(key => Object.hasOwn(metric, key)) : ['value'];
    if (!values.length || values.some(key => !numeric(metric[key]))) throw new Error(`Invalid metric: ${name}`);
    if (kind === 'baseline' && metric.min !== undefined && metric.max !== undefined && (metric.min as number) > (metric.max as number)) throw new Error(`Inverted limits: ${name}`);
  }
  return structuredClone(value) as PerformanceDocument;
}

export function checkPerformanceBaseline(baseline: unknown, measurement: unknown) {
  const violations: string[] = [];
  try {
    const expected = parsePerformanceDocument(baseline, 'baseline');
    const actual = parsePerformanceDocument(measurement, 'measurement');
    for (const key of ['platform', 'deviceModel', 'osVersion', 'appId', 'scenario', 'collector', 'collectorVersion'] as const) {
      if (expected.context[key] !== actual.context[key]) violations.push(`Incompatible context: ${key}`);
    }
    for (const key of ['durationMs', 'iterations', 'warmupIterations', 'aggregation'] as const) {
      if (expected.context.sampling[key] !== actual.context.sampling[key]) violations.push(`Incompatible sampling: ${key}`);
    }
    for (const [name, limit] of Object.entries(expected.metrics)) {
      const metric = Object.hasOwn(actual.metrics, name) ? actual.metrics[name] : undefined;
      if (!metric) { violations.push(`Missing metric: ${name}`); continue; }
      if (metric.unit !== limit.unit) { violations.push(`Incompatible unit: ${name} (${limit.unit} vs ${metric.unit})`); continue; }
      if (limit.max !== undefined && metric.value! > limit.max) violations.push(`${name}: ${metric.value} > ${limit.max} ${limit.unit}`);
      if (limit.min !== undefined && metric.value! < limit.min) violations.push(`${name}: ${metric.value} < ${limit.min} ${limit.unit}`);
    }
  } catch (error) { violations.push(String(error)); }
  return { version: 2, passed: violations.length === 0, violations };
}
