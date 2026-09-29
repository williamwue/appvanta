import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdbDriver } from '../dist/index.js';

test('extracts decoded text and labels from the supplied observation, refusing ambiguous or password nodes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appvanta-extract-'));
  const path = join(root, 'ui.xml');
  const driver = new AdbDriver({ adbPath: 'must-not-run-adb', artifactsDirectory: root });
  const extraction = { name: 'x', target: { kind: 'resource-id', value: 'app:id/value' }, attribute: 'text' };
  const observation = { capturedAt: new Date().toISOString(), metadata: {}, uiTreePath: path };
  const node = (attributes = '') => `<node resource-id="app:id/value" text="中文 &amp; café" content-desc="Label &quot;quoted&quot;" bounds="[0,0][20,20]" visible-to-user="true" ${attributes}/>`;
  try {
    await writeFile(path, `<hierarchy>${node()}</hierarchy>`);
    assert.equal(await driver.extractValue('fake', extraction, observation), '中文 & café');
    assert.equal(await driver.extractValue('fake', { ...extraction, attribute: 'accessibility-label' }, observation), 'Label "quoted"');
    await writeFile(path, `<hierarchy>${node()}${node()}</hierarchy>`);
    await assert.rejects(driver.extractValue('fake', extraction, observation), /Ambiguous/);
    assert.equal(await driver.extractValue('fake', { ...extraction, target: { ...extraction.target, occurrence: 1 } }, observation), '中文 & café');
    await writeFile(path, `<hierarchy>${node('password="true"')}</hierarchy>`);
    await assert.rejects(driver.extractValue('fake', extraction, observation), /password/);
    await writeFile(path, '<hierarchy><node resource-id="app:id/value" text="" bounds="[0,0][20,20]" visible-to-user="true"/></hierarchy>');
    assert.equal(await driver.extractValue('fake', extraction, observation), '');
    await assert.rejects(driver.extractValue('fake', { ...extraction, target: { kind: 'text', value: 'missing' } }, observation), /not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
