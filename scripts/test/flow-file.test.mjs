import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFlowFile } from '../../packages/cli/dist/flow-file.js';

test('CLI reads equivalent JSON and bounded YAML Flow files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-flow-file-'));
  try {
    const json = join(root, 'flow.json'), yaml = join(root, 'flow.yaml'), duplicate = join(root, 'duplicate.yml');
    const value = { version: 1, name: 'portable', steps: [{ description: 'note', echo: 'hello' }, { description: 'back', action: { kind: 'back' } }] };
    await writeFile(json, JSON.stringify(value));
    await writeFile(yaml, 'version: 1\nname: portable\nsteps:\n  - description: note\n    echo: hello\n  - description: back\n    action:\n      kind: back\n');
    await writeFile(duplicate, 'name: one\nname: two\nsteps:\n  - description: note\n    echo: hello\n');
    assert.deepEqual(await readFlowFile(yaml), await readFlowFile(json));
    await assert.rejects(readFlowFile(duplicate), /Map keys must be unique|Invalid YAML/);
    await assert.rejects(readFlowFile(join(root, 'flow.txt')), /Flow file must/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI rejects deeply nested YAML Flow with a bounded parsing error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-flow-file-'));
  try {
    const nested = join(root, 'nested.yaml');
    await writeFile(nested, `version: 1\nname: nested\nsteps: ${'['.repeat(5000)}0${']'.repeat(5000)}\n`);
    await assert.rejects(readFlowFile(nested), error =>
      error instanceof Error &&
      !(error instanceof RangeError) &&
      error.message.startsWith('Invalid YAML Flow:') &&
      error.message.length < 500,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
