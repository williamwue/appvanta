import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AdbDriver, parseUiTree } from '../packages/android/dist/index.js';
import { withDeviceLock } from '../packages/core/dist/index.js';

const exec = promisify(execFile);
const serial = process.argv[2]; assert(serial, 'Usage: node scripts/verify-gestures.mjs <device>');
const root = resolve('.appvanta/runs', `gestures-${Date.now()}`); await mkdir(root, { recursive: true });
const driver = new AdbDriver({ artifactsDirectory: join(root, 'artifacts') });
await withDeviceLock(serial, async () => {
  const shell = async args => (await exec('adb', ['-s', serial, 'shell', ...args], { encoding: 'utf8', timeout: 20000 })).stdout.trim();
  await shell(['am', 'start', '-W', '-n', 'dev.appvanta.input/.GestureActivity']);
  const sizeText = await shell(['wm', 'size']);
  const match = /Physical size:\s*(\d+)x(\d+)/.exec(sizeText) ?? /(\d+)x(\d+)/.exec(sizeText);
  assert(match, `Cannot parse display size: ${sizeText}`);
  const width = Number(match[1]), height = Number(match[2]), center = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const radius = Math.max(20, Math.floor(Math.min(width, height) / 8));
  const actions = [
    { kind: 'pinch', center, startSpan: radius * 2, endSpan: radius, durationMs: 500 },
    { kind: 'rotate-gesture', center, radius, degrees: 90, durationMs: 500 },
    { kind: 'multi-touch', durationMs: 500, strokes: [
      { points: [{ x: center.x - radius, y: center.y - radius }, { x: center.x - radius, y: center.y + radius }] },
      { points: [{ x: center.x + radius, y: center.y - radius }, { x: center.x + radius, y: center.y + radius }] },
    ] },
  ];
  const evidence = [];
  for (const action of actions) {
    await driver.execute(serial, action);
    const observation = await driver.observe(serial); evidence.push(observation);
    const tree = parseUiTree(await readFile(observation.uiTreePath, 'utf8'));
    assert(JSON.stringify(tree).includes('Pointers: 2'), `${action.kind} did not deliver simultaneous pointers`);
  }
  const result = { status: 'passed', serial, display: { width, height }, actions: actions.map(action => action.kind), simultaneousPointers: 2, evidence };
  await writeFile(join(root, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, evidence: root }));
});
