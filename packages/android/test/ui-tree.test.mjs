import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUiTree, findNodes, findNode, center, interactionCandidates, AdbDriver } from '../dist/index.js';
import { parseTarget } from '../../core/dist/index.js';

const xml = `<hierarchy><node class="android.View" bounds="[0,0][200,400]">
  <node resource-id="left" bounds="[0,0][100,200]">
    <node text="Save" content-desc="Save &amp; close" resource-id="button" clickable="true" focused="true" selected="true" checked="true" checkable="true" bounds="[0,0][50,50]" />
    <node text="Save as" bounds="[0,50][50,100]" />
  </node>
  <node resource-id="right" bounds="[100,0][200,200]">
    <node text="Save" resource-id="button" clickable="true" bounds="[100,0][150,50]" />
    <node text="Disabled" clickable="true" enabled="false" bounds="[100,50][150,100]" />
    <node text="Hidden" visible-to-user="false" bounds="[100,100][150,150]" />
    <node text="中文 &#x1F642; &#10; &quot;&gt;&lt;&apos;&amp;" bounds="[-5,150][150,180]" />
  </node>
</node></hierarchy>`;

test('UI tree preserves hierarchy, state, negative bounds and XML character data', () => {
  const tree = parseUiTree(xml);
  assert.deepEqual(tree.roots, ['0']);
  assert.deepEqual(tree.nodes[0].childPaths, ['0/0', '0/1']);
  const button = tree.nodes.find(n => n.path === '0/0/0');
  assert.equal(button.parentPath, '0/0');
  assert(button.checked && button.focused && button.selected && button.clickable);
  assert.equal(button.contentDescription, 'Save & close');
  assert.equal(tree.nodes.at(-1).text, '中文 🙂 \n "><\'&');
  assert.equal(tree.nodes.at(-1).bounds.left, -5);
  assert.equal(findNodes(tree, { kind: 'text', value: 'Hidden' }).length, 0);
  const clipped = parseUiTree('<node text="Off screen" bounds="[221,2372][612,2361]"/>');
  assert.equal(clipped.nodes[0].visible, false);
  assert.equal(findNodes(clipped, { kind: 'text', value: 'Off screen' }).length, 0);
  for (const malformed of ['ERROR: null root node', '<node bounds="[0,0][1,1]">', '<node bounds="broken"/>', '<!DOCTYPE x><hierarchy/>', '<hierarchy><node bounds="[0,0][1,1]"/>', '<hierarchy><node text="broken></hierarchy>']) assert.throws(() => parseUiTree(malformed));
});

test('ambiguous actions fail; scoped paths, occurrence and explicit matching resolve correctly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-ui-'));
  try {
    const file = join(root, 'ui.xml'); await writeFile(file, xml);
    await assert.rejects(findNode(file, { kind: 'text', value: 'Save' }), /Ambiguous/);
    assert.equal((await findNode(file, { kind: 'text', value: 'Save', within: '0/1' })).path, '0/1/0');
    assert.equal((await findNode(file, { kind: 'text', value: 'Save', occurrence: 1 })).path, '0/1/0');
    assert.equal((await findNode(file, { kind: 'ui-path', value: '0/0/0' })).resourceId, 'button');
    assert.equal(findNodes(parseUiTree(xml), { kind: 'text', value: 'Save', match: 'contains' }).length, 3);
    await assert.rejects(findNode(file, { kind: 'text', value: 'Sav' }), /not found/);
    await assert.rejects(findNode(file, { kind: 'text', value: 'Save', occurrence: 99 }), /not found/);
    assert.throws(() => center(parseUiTree(xml).nodes.find(n => n.text === 'Disabled')), /disabled/);
    assert.throws(() => parseTarget({ kind: 'text', value: 'Save', occurrence: -1 }));
    assert.throws(() => parseTarget({ kind: 'resource-id', value: 'button', match: 'contains' }));
    const candidates = interactionCandidates(parseUiTree(xml));
    assert.equal(candidates.length, 2);
    for (const candidate of candidates) assert.equal((await findNode(file, candidate.target)).path, candidate.path);
    const driver = new AdbDriver({ adbPath: 'must-not-be-executed', artifactsDirectory: root });
    assert.equal(await driver.checkCondition('test', { kind: 'text-visible', text: 'Save' }, { uiTreePath: file, metadata: {}, capturedAt: '' }), true);
    assert.equal(await driver.checkCondition('test', { kind: 'text-absent', text: 'Save' }, { uiTreePath: file, metadata: {}, capturedAt: '' }), false);
    assert.equal(await driver.checkCondition('test', { kind: 'target-absent', target: { kind: 'resource-id', value: 'missing' } }, { uiTreePath: file, metadata: {}, capturedAt: '' }), true);
    assert.equal(await driver.checkCondition('test', { kind: 'ui-changed' }, { uiTreePath: file, metadata: {}, capturedAt: '' }, parseUiTree(xml)), false);
    await writeFile(file, xml.replace('Save as', 'Save copy'));
    assert.equal(await driver.checkCondition('test', { kind: 'ui-changed' }, { uiTreePath: file, metadata: {}, capturedAt: '' }, parseUiTree(xml)), true);
    await writeFile(file, 'ERROR: missing hierarchy');
    await assert.rejects(driver.checkCondition('test', { kind: 'text-absent', text: 'Save' }, { uiTreePath: file, metadata: {}, capturedAt: '' }), /missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
