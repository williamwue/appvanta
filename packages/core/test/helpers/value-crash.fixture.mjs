import { createRunContext, executeFlow, parseFlow } from '../../dist/index.js';
const target = { kind: 'resource-id', value: 'app:id/editor' };
const mode = process.argv[3];
const stall = async () => { process.send({ root: context.rootDirectory }); await new Promise(() => setInterval(() => {}, 1000)); };
let observations = 0;
const driver = { name: 'value-crash', observe: async () => {
  if (++observations === 2 && mode === 'after-value') await stall();
  return { capturedAt: new Date().toISOString(), metadata: {} };
}, extractValue: async () => {
  if (mode === 'during-read') await stall();
  return 'Persisted 中文\nvalue';
} };
const context = await createRunContext({ runsDirectory: process.argv[2], driver, device: { id: 'fake', name: 'fake', platform: 'android', status: 'online', capabilities: [] } });
let count = 0;
await executeFlow({ context, driver, flow: parseFlow({ name: 'Value crash', steps: [
  { description: 'Read', extract: { name: 'saved', target, attribute: 'text' } },
  { description: 'Write', inputValue: { name: 'saved', target } },
] }), beforeStep: async () => {
  if (++count === 2) { process.send({ root: context.rootDirectory }); await new Promise(() => setInterval(() => {}, 1000)); }
} });
