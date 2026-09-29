import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../dist/index.js';

test('Flow templates expand typed bindings and parameterized fragments into concrete plans', () => {
  assert.equal(typeof core.compileFlowTemplate, 'function');
  const source = { name: 'Reusable', variables: { app: 'net.gsantner.markor', timeout: 1000 }, fragments: {
    launch: { parameters: ['package'], steps: [{ description: 'Launch', launchPackage: { $var: 'package' }, action: { kind: 'wait', condition: { kind: 'app-running', packageName: { $var: 'package' } }, timeoutMs: { $var: 'timeout' } } }] },
    twice: { parameters: ['package'], steps: [{ use: 'launch', with: { package: { $var: 'package' } } }, { use: 'launch', with: { package: { $var: 'package' } } }] },
  }, steps: [{ use: 'twice', with: { package: { $var: 'app' } } }, { description: 'Literal', echo: '${not-expanded}' }] };
  const before = JSON.stringify(source), result = core.compileFlowTemplate(source);
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0].launchPackage, 'net.gsantner.markor');
  assert.equal(result.steps[1].action.timeoutMs, 1000);
  assert.equal(result.steps[2].echo, '${not-expanded}');
  assert.deepEqual(core.parseFlow(result), result);
  assert.equal(JSON.stringify(source), before);
  result.steps[0].description = 'Changed';
  assert.equal(result.steps[1].description, 'Launch');
});

test('Flow templates reject missing, extra, unsafe and invalid bindings before execution', () => {
  const compile = core.compileFlowTemplate;
  assert.equal(typeof compile, 'function');
  const make = value => ({ name: 'Typed', variables: { value }, steps: [{ description: 'Wait', action: { kind: 'wait', condition: { kind: 'app-running', packageName: 'net.gsantner.markor' }, timeoutMs: { $var: 'value' } } }] });
  assert.throws(() => compile(make('1000')), /integer/);
  assert.throws(() => compile(make({ nested: true })), /scalar/);
  assert.throws(() => compile({ name: 'Missing', steps: [{ description: 'Read', echo: { $var: 'missing' } }] }), /Unknown variable/);
  const fragment = { parameters: ['text'], steps: [{ description: 'Output', echo: { $var: 'text' } }] };
  for (const args of [{}, { text: 'ok', extra: 'bad' }]) assert.throws(() => compile({ name: 'Args', fragments: { output: fragment }, steps: [{ use: 'output', with: args }] }), /arguments/);
  assert.throws(() => compile({ name: 'Bad', variables: JSON.parse('{"__proto__":"bad"}'), steps: [{ description: 'x', echo: 'x' }] }), /name/);
  assert.throws(() => compile({ name: 'Bad', steps: [{ description: 'x', echo: { $var: 'x', extra: true } }] }), /reference/);
});

test('Flow fragment expansion refuses recursion and excessive plans', () => {
  assert.equal(typeof core.compileFlowTemplate, 'function');
  assert.throws(() => core.compileFlowTemplate({ name: 'Cycle', fragments: { a: { parameters: [], steps: [{ use: 'b' }] }, b: { parameters: [], steps: [{ use: 'a' }] } }, steps: [{ use: 'a' }] }), /Recursive/);
  assert.throws(() => core.compileFlowTemplate({ name: 'Large', steps: Array.from({ length: 1001 }, () => ({ description: 'x', echo: 'x' })) }), /1000/);
});

test('Flow fragment scopes inherit globals without leaking caller parameters', () => {
  const template = { name: 'Scope', variables: { text: 'global' }, fragments: {
    inner: { parameters: [], steps: [{ description: 'Output', echo: { $var: 'text' } }] },
    outer: { parameters: ['text'], steps: [{ use: 'inner' }] },
  }, steps: [{ use: 'outer', with: { text: 'local' } }] };
  assert.equal(core.compileFlowTemplate(template).steps[0].echo, 'global');
  delete template.variables;
  assert.throws(() => core.compileFlowTemplate(template), /Unknown variable: text/);
});
