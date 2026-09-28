import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNode, center } from '../dist/locator.js';

test('resolves resource id and computes center', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'appvanta-locator-'));
  const path = join(directory, 'ui.xml');
  await writeFile(path, '<node resource-id="demo:id/button" text="Save" content-desc="Save button" bounds="[10,20][110,80]" />');
  const node = await findNode(path, { kind: 'resource-id', value: 'demo:id/button' });
  assert.deepEqual(center(node), { x: 60, y: 50 });
});

test('resolves accessibility label and text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'appvanta-locator-'));
  const path = join(directory, 'ui.xml');
  await writeFile(path, '<node content-desc="Search" text="" bounds="[0,0][20,20]" /><node text="Markor" bounds="[20,20][40,40]" />');
  assert.equal((await findNode(path, { kind: 'accessibility-label', value: 'Search' })).bounds.right, 20);
  assert.equal((await findNode(path, { kind: 'text', value: 'Markor' })).bounds.bottom, 40);
});
