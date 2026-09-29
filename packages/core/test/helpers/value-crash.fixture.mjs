import { createRunContext, executeFlow, parseFlow } from '../../dist/index.js';
const target = { kind: 'resource-id', value: 'app:id/editor' };
const driver = { name: 'value-crash', observe: async () => ({ capturedAt: new Date().toISOString(), metadata: {} }), extractValue: async () => 'Persisted 中文\nvalue' };
const context = await createRunContext({ runsDirectory: process.argv[2], driver, device: { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] } });
let count = 0;
await executeFlow({ context, driver, flow: parseFlow({ name: 'Value crash', steps: [
  { description: 'Read', extract: { name: 'saved', target, attribute: 'text' } },
  { description: 'Write', inputValue: { name: 'saved', target } },
] }), beforeStep: async () => {
  if (++count === 2) { process.send({ root: context.rootDirectory }); await new Promise(() => setInterval(() => {}, 1000)); }
} });
