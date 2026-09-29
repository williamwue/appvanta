import { parseFlow, type FlowDefinition } from './flow-schema.js';

type Scalar = string | number | boolean | null;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected template object');
  return value as Record<string, unknown>;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid template name');
  return value;
}
function scalar(value: unknown): Scalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error('Template bindings must be finite JSON scalars');
}

/** Compile once before admission; persisted runs contain only the validated concrete Flow. */
export function compileFlowTemplate(input: unknown): FlowDefinition {
  const source = record(input);
  const globals = new Map<string, Scalar>();
  for (const [key, value] of Object.entries(source.variables === undefined ? {} : record(source.variables))) globals.set(name(key), scalar(value));
  if (globals.size > 100) throw new Error('Template supports at most 100 variables');
  const fragments = new Map<string, { parameters: string[]; steps: unknown[] }>();
  for (const [key, value] of Object.entries(source.fragments === undefined ? {} : record(source.fragments))) {
    const fragment = record(value);
    if (Object.keys(fragment).some(key => !['parameters', 'steps'].includes(key))) throw new Error('Unknown fragment field');
    if (!Array.isArray(fragment.parameters) || fragment.parameters.length > 100) throw new Error('Fragment requires at most 100 parameters');
    const parameters = fragment.parameters.map(name);
    if (new Set(parameters).size !== parameters.length) throw new Error('Duplicate fragment parameter');
    if (!Array.isArray(fragment.steps) || !fragment.steps.length) throw new Error('Fragment requires non-empty steps');
    fragments.set(name(key), { parameters, steps: fragment.steps });
  }
  if (fragments.size > 100) throw new Error('Template supports at most 100 fragments');
  let nodes = 0;
  const resolve = (value: unknown, scope: Map<string, Scalar>, depth = 0): unknown => {
    if (++nodes > 100000 || depth > 32) throw new Error('Template expansion exceeds structural limits');
    if (Array.isArray(value)) return value.map(item => resolve(item, scope, depth + 1));
    if (value && typeof value === 'object') {
      const object = record(value);
      if (Object.hasOwn(object, '$var')) {
        if (Object.keys(object).length !== 1) throw new Error('Variable reference must contain only $var');
        const key = name(object.$var);
        if (!scope.has(key)) throw new Error(`Unknown variable: ${key}`);
        return scope.get(key);
      }
      return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, resolve(child, scope, depth + 1)]));
    }
    return scalar(value);
  };
  const steps: unknown[] = [];
  const expand = (items: unknown, scope: Map<string, Scalar>, stack: string[]) => {
    if (!Array.isArray(items) || !items.length) throw new Error('Template requires non-empty steps');
    if (stack.length > 32) throw new Error('Fragment nesting exceeds 32 levels');
    for (const item of items) {
      const step = record(item);
      if (Object.hasOwn(step, 'use')) {
        if (Object.keys(step).some(key => !['use', 'with'].includes(key))) throw new Error('Unknown fragment invocation field');
        const key = name(step.use), fragment = fragments.get(key);
        if (!fragment) throw new Error(`Unknown fragment: ${key}`);
        if (stack.includes(key)) throw new Error(`Recursive fragment: ${[...stack, key].join(' -> ')}`);
        const args = step.with === undefined ? {} : record(step.with);
        if (Object.keys(args).length !== fragment.parameters.length || fragment.parameters.some(parameter => !Object.hasOwn(args, parameter))) throw new Error(`Fragment arguments do not match parameters: ${key}`);
        const local = new Map(globals);
        for (const parameter of fragment.parameters) local.set(parameter, scalar(resolve(args[parameter], scope)));
        expand(fragment.steps, local, [...stack, key]);
      } else {
        if (steps.length >= 1000) throw new Error('Template expands beyond 1000 steps');
        steps.push(resolve(step, scope));
      }
    }
  };
  expand(source.steps, globals, []);
  const { variables: _variables, fragments: _fragments, steps: _steps, ...configuration } = source;
  return parseFlow({ ...record(resolve(configuration, globals)), steps });
}
