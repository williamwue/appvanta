import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseFlow } from '../../packages/core/dist/index.js';

test('every documented JSON Flow satisfies the runtime schema', async () => {
  const directory = resolve('docs/examples');
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  assert(files.length > 0);
  for (const file of files) {
    const flow = parseFlow(JSON.parse(await readFile(join(directory, file), 'utf8')));
    assert.equal(flow.version, 1, file);
    assert(flow.steps.length > 0, file);
  }
});
