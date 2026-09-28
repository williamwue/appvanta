import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPerformanceBaseline } from '../dist/index.js';

export const context = { platform: 'android', deviceModel: 'test-model', osVersion: '37', appId: 'net.gsantner.markor', scenario: 'open-note', collector: 'fixture', collectorVersion: '1', sampling: { durationMs: 10000, iterations: 3, warmupIterations: 1, aggregation: 'median' } };
export const baseline = { version: 2, kind: 'baseline', context, metrics: { duration: { unit: 'ms', max: 100 }, fps: { unit: 'fps', min: 30, max: 120 } } };
export const measurement = { version: 2, kind: 'measurement', context, metrics: { duration: { unit: 'ms', value: 100 }, fps: { unit: 'fps', value: 30 } } };

test('versioned performance gates reject incompatible units, collection conditions and malformed documents', () => {
  const check = value => checkPerformanceBaseline(baseline, value);
  assert.equal(check(measurement).passed, true);
  for (const key of ['platform', 'deviceModel', 'osVersion', 'appId', 'scenario', 'collector', 'collectorVersion']) {
    const value = structuredClone(measurement); value.context[key] += '-changed'; assert.equal(check(value).passed, false);
  }
  for (const key of ['durationMs', 'iterations', 'warmupIterations']) {
    const value = structuredClone(measurement); value.context.sampling[key]++; assert.equal(check(value).passed, false);
  }
  for (const mutate of [
    value => { value.version = 3; }, value => { value.context.sampling.aggregation = 'mean'; },
    value => { value.metrics.duration.unit = 'ns'; }, value => { value.metrics.duration.value = 101; },
    value => { value.metrics.fps.value = 29; }, value => { delete value.metrics.duration; },
    value => { value.metrics.duration.value = NaN; }, value => { value.metrics.duration.value = -1; },
    value => { value.context.sampling.iterations = 0; }, value => { value.context.sampling.durationMs = 1.5; },
    value => { value.context.sampling.extra = true; }, value => { value.metrics.duration.unit = 'unknown'; },
    value => { value.context.sampling.aggregation = 'single'; }, value => { value.context.collectorVersion = ''; },
  ]) { const value = structuredClone(measurement); mutate(value); assert.equal(check(value).passed, false); }
  for (const limits of [{ unit: 'ms' }, { unit: 'ms', min: 2, max: 1 }, { unit: 'ms', max: Infinity }]) {
    assert.equal(checkPerformanceBaseline({ ...baseline, metrics: { duration: limits } }, measurement).passed, false);
  }
  assert.equal(checkPerformanceBaseline({ ...baseline, version: 1 }, measurement).passed, false);
});
