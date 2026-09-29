import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseFlow } from '../packages/core/dist/index.js';

const root = resolve('.appvanta/runs', `flow-template-${Date.now()}`);
await mkdir(root, { recursive: true });
const output = join(root, 'compiled.json');
const cli = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, ['packages/cli/dist/index.js', ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true })).stdout);
const compiled = await cli('compile-flow', 'docs/templates/markor.json', output);
assert.equal(compiled.status, 'compiled');
const bytes = await readFile(output, 'utf8'), flow = parseFlow(JSON.parse(bytes));
assert.equal(flow.steps[0].launchPackage, 'net.gsantner.markor');
assert.equal(flow.steps[0].action.timeoutMs, 10000);
assert(!Object.hasOwn(flow, 'variables') && !Object.hasOwn(flow, 'fragments'));
await assert.rejects(cli('compile-flow', 'docs/templates/markor.json', output), /EEXIST/);
assert.equal(await readFile(output, 'utf8'), bytes);
let run;
if (process.argv[2]) {
  run = await cli('run-flow', process.argv[2], output);
  assert.equal(run.status, 'passed'); assert.equal(run.cleanupFailed, false);
  assert.deepEqual(JSON.parse(await readFile(join(run.runDirectory, 'flow.json'), 'utf8')), flow);
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', compiled, flow, existingOutputPreserved: true, run }, null, 2));
console.log(JSON.stringify({ status: 'passed', root, deviceExecuted: !!run }));
