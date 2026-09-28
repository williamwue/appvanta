import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { AdbDriver, findNode } from '../packages/android/dist/index.js';
import { brand, createRunContext, writeMarkdownReport } from '../packages/core/dist/index.js';

// Requires installed Markor with onboarding and storage permission completed.
const probe = new AdbDriver({ artifactsDirectory: '.appvanta/probe' });
const devices = (await probe.listDevices()).filter(device => device.status === 'online');
const serial = process.argv[2];
const device = serial ? devices.find(device => device.id === serial) : devices.length === 1 ? devices[0] : undefined;
assert(device, 'Specify one online device: node scripts/verify-markor.mjs <serial>');
const context = await createRunContext({ runsDirectory: resolve('.appvanta/runs'), driver: probe, device });
const driver = new AdbDriver({ artifactsDirectory: join(context.rootDirectory, 'artifacts') });
const marker = `#AppVanta${Date.now()}`;
const inputText = process.env.APPVANTA_COMPLEX_INPUT === '1'
  ? `${marker} 中文测试 café 😀\n第二行：%s ' " \\ & | ; $() < >\n结束${marker}` : marker;
const quickNotePath = process.argv[3] ?? '/storage/emulated/0/Documents/markor/QuickNote.md';
assert(quickNotePath.startsWith('/storage/emulated/0/'), 'QuickNote must be in shared device storage');
const exec = promisify(execFile);
const readQuickNote = async () => {
  const localFile = join(context.rootDirectory, 'quicknote-current.md');
  await exec('adb', ['-s', device.id, 'pull', quickNotePath, localFile], { encoding: 'utf8', timeout: 20000 });
  return readFile(localFile, 'utf8');
};
const editor = { kind: 'resource-id', value: 'net.gsantner.markor:id/document__fragment__edit__highlighting_editor' };
const steps = [];
let status = 'running';
const local = path => relative(context.rootDirectory, path).replaceAll('\\', '/');
const saveJson = (name, value) => writeFile(join(context.rootDirectory, name), JSON.stringify(value, null, 2) + '\n');
await saveJson('device.json', device);
await saveJson('run.json', { ...context.metadata, status });
await context.evidence.savePlan('# Markor verification\n\nLaunch, open QuickNote, preserve the original file as evidence, insert a unique marker, open preview, verify the saved file and rendered text, collect Logcat.\n\nRequires completed onboarding and storage permission. Adds text to QuickNote; does not clear existing notes.\n');

async function step(description, operation) {
  const started = Date.now();
  const record = { index: steps.length + 1, description, status: 'failed', evidence: [] };
  try {
    const before = await driver.observe(device.id);
    record.evidence.push(local(before.screenshotPath), local(before.uiTreePath));
    // Each ADB operation has its own deadline. Do not leave a timed-out operation
    // running in the background while failure evidence or a later step executes.
    const extraEvidence = await operation(before);
    if (Array.isArray(extraEvidence)) record.evidence.push(...extraEvidence);
    const after = await driver.observe(device.id);
    record.evidence.push(local(after.screenshotPath), local(after.uiTreePath));
    record.status = 'passed';
  } catch (error) {
    record.message = error instanceof Error ? error.message : String(error);
    try {
      const failure = await driver.observe(device.id);
      record.evidence.push(local(failure.screenshotPath), local(failure.uiTreePath));
    } catch (captureError) {
      record.message += `; re-observation failed: ${String(captureError)}`;
    }
    throw error;
  } finally {
    record.durationMs = Date.now() - started;
    steps.push(record);
    await context.evidence.appendStep(record);
  }
}

try {
  await step('Launch Markor', async () => {
    await driver.launch(device.id, brand('net.gsantner.markor'));
  });
  await step('Open QuickNote', async () => {
    const observation = await driver.observe(device.id);
    let xml = await readFile(observation.uiTreePath, 'utf8');
    if (xml.includes('text="NO THANKS"')) {
      await driver.execute(device.id, { kind: 'tap', target: { kind: 'text', value: 'NO THANKS' } });
      const dismissed = await driver.observe(device.id);
      xml = await readFile(dismissed.uiTreePath, 'utf8');
    }
    for (const label of ['GET STARTED', 'OK', 'CONTINUE', 'SKIP', 'DONE', 'FINISH']) {
      if (xml.includes(`text="${label}"`)) {
        await driver.execute(device.id, { kind: 'tap', target: { kind: 'text', value: label } });
        const advanced = await driver.observe(device.id);
        xml = await readFile(advanced.uiTreePath, 'utf8');
      }
    }
    for (let page = 0; page < 8 && xml.includes('content-desc="NEXT"'); page++) {
      await driver.execute(device.id, { kind: 'tap', target: { kind: 'accessibility-label', value: 'NEXT' } });
      const advanced = await driver.observe(device.id);
      xml = await readFile(advanced.uiTreePath, 'utf8');
    }
    if (xml.includes('resource-id="net.gsantner.markor:id/done"')) {
      await driver.execute(device.id, { kind: 'tap', target: { kind: 'resource-id', value: 'net.gsantner.markor:id/done' } });
      const completed = await driver.observe(device.id);
      xml = await readFile(completed.uiTreePath, 'utf8');
    }
    if (!xml.includes('document__fragment__edit__highlighting_editor')) {
      const target = xml.includes('resource-id="net.gsantner.markor:id/nav_quicknote"')
        ? { kind: 'resource-id', value: 'net.gsantner.markor:id/nav_quicknote' }
        : { kind: 'text', value: 'QuickNote' };
      await driver.execute(device.id, { kind: 'tap', target });
      const navigated = await driver.observe(device.id);
      xml = await readFile(navigated.uiTreePath, 'utf8');
    }
    if (xml.includes('content-desc="Edit Mode"')) {
      await driver.execute(device.id, { kind: 'tap', target: { kind: 'accessibility-label', value: 'Edit Mode' } });
    }
    const editable = await driver.observe(device.id);
    await findNode(editable.uiTreePath, editor);
  });
  await step('Preserve QuickNote and insert unique marker', async () => {
    const before = await readQuickNote();
    assert(!before.includes(marker), 'Unique marker already exists before input');
    await writeFile(join(context.rootDirectory, 'artifacts/quicknote-before.md'), before);
    await driver.execute(device.id, { kind: 'input', target: editor, text: inputText });
    return ['artifacts/quicknote-before.md'];
  });
  await step('Open preview and verify rendered marker', async () => {
    await driver.execute(device.id, { kind: 'tap', target: { kind: 'accessibility-label', value: 'View Mode' } });
    const deadline = Date.now() + 10000;
    let xml;
    do {
      const observation = await driver.observe(device.id);
      xml = await readFile(observation.uiTreePath, 'utf8');
      if (xml.includes('android.webkit.WebView') && xml.includes(marker)) break;
    } while (Date.now() < deadline);
    assert(xml.includes('android.webkit.WebView'), 'Preview WebView absent');
    assert(xml.includes(marker), 'Rendered marker absent from preview UI tree');
  });
  await step('Leave QuickNote to save and verify file content', async () => {
    await driver.execute(device.id, { kind: 'tap', target: { kind: 'resource-id', value: 'net.gsantner.markor:id/nav_notebook' } });
    const deadline = Date.now() + 5000;
    let content;
    do {
      content = await readQuickNote();
      await writeFile(join(context.rootDirectory, 'artifacts/quicknote-after.md'), content);
      if (content.includes(marker)) break;
      await new Promise(done => setTimeout(done, 200));
    } while (Date.now() < deadline);
    assert(content.includes(inputText), 'Saved QuickNote does not contain the exact complete input text');
    await saveJson('artifacts/input-check.json', { quickNotePath, marker, inputText, savedFileContainsMarker: true });
    return ['artifacts/quicknote-after.md', 'artifacts/input-check.json'];
  });
  status = 'passed';
} catch (error) {
  status = 'failed';
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  try {
    await step('Collect Logcat (device buffer; not app-filtered)', async () => {
      const logs = await driver.collectLogs(device.id);
      await saveJson('logs/index.json', { ...logs, path: local(logs.path) });
    });
  } catch {
    status = 'failed';
    process.exitCode = 1;
  }
  const metadata = { ...context.metadata, status };
  await saveJson('run.json', { ...metadata, finishedAt: new Date().toISOString(), marker });
  await saveJson('report.json', { metadata, deviceName: device.name, steps });
  const report = await writeMarkdownReport(context.rootDirectory, { metadata, deviceName: device.name, steps });
  assert.equal(JSON.parse(await readFile(join(context.rootDirectory, 'run.json'), 'utf8')).status, status);
  for (const entry of steps) for (const path of entry.evidence) {
    const bytes = await readFile(join(context.rootDirectory, path));
    // An empty note before input is legitimate; captured media and post-input
    // content must remain non-empty.
    if (path !== 'artifacts/quicknote-before.md') assert(bytes.length > 0);
  }
  console.log(JSON.stringify({ status, report, steps: steps.length }));
}
