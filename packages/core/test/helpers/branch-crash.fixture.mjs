import { createRunContext, executeFlow, parseFlow, compileFlowTemplate } from '../../dist/index.js';
const branch = equals => ({ key: 'ready', when: { kind: 'text-visible', text: 'Ready' }, equals });
const activeBranch = process.argv[3] === 'active-branch';
const driver = { name: 'branch-crash', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), checkCondition: async () => process.argv[3] !== 'nested-false', execute: async () => {
  if (activeBranch) { process.send({ root: context.rootDirectory }); await new Promise(() => setInterval(() => {}, 1000)); }
  return { success: true };
} };
const context = await createRunContext({ runsDirectory: process.argv[2], driver, device: { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] } });
let step = 0;
const flow = process.argv[3]?.startsWith('nested-') ? compileFlowTemplate({ name: 'Nested crash', steps: [{ if: { kind: 'text-visible', text: 'Outer' }, then: [
  { if: { kind: 'text-visible', text: 'Inner' }, then: [{ description: 'First', echo: 'first' }, { description: 'Second', echo: 'second' }], else: [{ description: 'Inner else', echo: 'inner else' }] },
], else: [{ description: 'Outer else', echo: 'outer else' }] }] }) : parseFlow({ name: 'Interrupted branch', steps: [
  { description: 'Completed', branch: branch(true), ...(activeBranch ? { action: { kind: 'button', button: 'back' } } : { echo: 'first' }) },
  { description: 'Then remaining', branch: branch(true), action: { kind: 'button', button: 'back' } },
  { description: 'Else remaining', branch: branch(false), action: { kind: 'button', button: 'home' } },
] });
await executeFlow({ context, driver, beforeStep: async () => { if (++step === 2) { process.send({ root: context.rootDirectory }); await new Promise(() => setInterval(() => {}, 1000)); } }, flow });
