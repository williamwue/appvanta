import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AdbDriver, parseUiTree, interactionCandidates, findNode, runAndroidFlow } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const serial = process.argv[2]; assert(serial, 'Usage: node scripts/verify-ui-wait.mjs <device>');
const root = resolve('.appvanta/runs', `ui-wait-${Date.now()}`);
await mkdir(root, { recursive: true });
const controller = new AbortController();
const driver = new AdbDriver({ artifactsDirectory: root, signal: controller.signal });
await withDeviceLock(serial, async () => {
  await driver.launch(serial, 'com.android.settings');
  const observed = await driver.observe(serial);
  const tree = JSON.parse(await readFile(observed.uiDescriptionPath));
  assert.deepEqual(tree, parseUiTree(await readFile(observed.uiTreePath, 'utf8')));
  const candidates = interactionCandidates(tree);
  assert(candidates.length > 0);
  for (const candidate of candidates) assert.equal((await findNode(observed.uiTreePath, candidate.target)).path, candidate.path);
  for (const condition of [
    { kind: 'app-running', packageName: 'com.android.settings' },
    { kind: 'target-visible', target: { kind: 'ui-path', value: tree.roots[0] } },
    { kind: 'text-absent', text: 'APPVANTA_MISSING_SENTINEL' },
    { kind: 'target-absent', target: { kind: 'resource-id', value: 'appvanta:id/missing' } },
  ]) await driver.execute(serial, { kind: 'wait', condition, timeoutMs: 10000 });
  const stableStarted = Date.now();
  await driver.execute(serial, { kind: 'wait', condition: { kind: 'screen-stable', stableMs: 600 }, timeoutMs: 10000 });
  const screenStableElapsedMs = Date.now() - stableStarted;
  assert(screenStableElapsedMs >= 600, 'Screen stability window was not enforced');
  for (const condition of [{ kind: 'ui-changed' }, { kind: 'text-absent', text: 'Settings' }, { kind: 'text-visible', text: 'QuickNote' }]) {
    await driver.launch(serial, 'com.android.settings');
    const initial = await driver.observe(serial);
    assert(await driver.checkCondition(serial, { kind: 'text-visible', text: 'Settings' }, initial));
    const before = new Set(await readdir(root));
    let failure, completed = false;
    const waiting = driver.execute(serial, { kind: 'wait', condition, timeoutMs: 20000 }).then(() => { completed = true; }, error => { failure = error; });
    try {
      const deadline = Date.now() + 12000;
      let baselineSaved = false;
      while (Date.now() < deadline && !failure) {
        baselineSaved = (await readdir(root)).some(name => name.endsWith('.json') && !before.has(name));
        if (baselineSaved) break;
        await delay(100);
      }
      assert(baselineSaved, 'Wait did not save its initial observation');
      assert(!completed, 'Wait completed before the fixture changed');
      await driver.launch(serial, 'net.gsantner.markor');
      await waiting;
      if (failure) throw failure;
    } catch (error) { controller.abort(); await waiting; throw error; }
  }
  const started = Date.now();
  await assert.rejects(driver.execute(serial, { kind: 'wait', condition: { kind: 'app-running', packageName: 'net.appvanta.missing' }, timeoutMs: 250 }), /Condition timed out/);
  const timeoutElapsedMs = Date.now() - started;
  assert(timeoutElapsedMs < 5000, 'Wait deadline was not enforced');
  const failed = await runAndroidFlow(serial, { name: 'Missing text wait evidence', steps: [{ description: 'Deliberate wait timeout', action: { kind: 'wait', condition: { kind: 'text-visible', text: 'APPVANTA_MISSING_SENTINEL' }, timeoutMs: 500 } }] });
  assert.equal(failed.status, 'failed');
  assert(failed.steps[0].evidence.some(path => path.endsWith('.json')));
  for (const file of failed.steps[0].evidence) assert((await readFile(join(failed.runDirectory, file))).length > 0);
  const result = { status: 'passed', serial, candidates: candidates.length, structuredUi: observed.uiDescriptionPath, uiChanged: true, screenStable: true, screenStableElapsedMs, textAppeared: true, textDisappeared: true, timeoutElapsedMs, failureRun: failed.runDirectory };
  await writeFile(join(root, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, evidence: root }));
});
