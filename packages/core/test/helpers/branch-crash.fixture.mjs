import { createRunContext, executeFlow, parseFlow } from '../../dist/index.js';
const branch = equals => ({ key: 'ready', when: { kind: 'text-visible', text: 'Ready' }, equals });
const driver = { name: 'branch-crash', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), checkCondition: async () => true, execute: async () => ({ success: true }) };
const context = await createRunContext({ runsDirectory: process.argv[2], driver, device: { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] } });
let step = 0;
await executeFlow({ context, driver, beforeStep: async () => { if (++step === 2) { process.send({ root: context.rootDirectory }); await new Promise(() => setInterval(() => {}, 1000)); } }, flow: parseFlow({ name: 'Interrupted branch', steps: [
  { description: 'Completed', branch: branch(true), echo: 'first' },
  { description: 'Then remaining', branch: branch(true), action: { kind: 'button', button: 'back' } },
  { description: 'Else remaining', branch: branch(false), action: { kind: 'button', button: 'home' } },
] }) });
