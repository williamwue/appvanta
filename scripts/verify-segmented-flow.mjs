import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runAndroidFlow } from '../packages/android/dist/index.js';

const device = process.argv[2]; assert(device, 'Device ID required');
const root = resolve('.appvanta/runs', `segmented-flow-${Date.now()}`); await mkdir(root, { recursive: true });
const records = [];
for (const scenario of ['passed', 'cancelled', 'expired']) {
  const controller = new AbortController(); let timer;
  try {
    const result = await runAndroidFlow(device, { name: `Segmented ${scenario}`, capture: { screenSeconds: scenario === 'expired' ? 5 : 60, screenSegmentSeconds: 5 },
      steps: [{ description: 'Final marker', echo: 'done' }] }, controller.signal, undefined, {
      drain: async () => [], finish: async () => {}, beforeStep: async () => {
        if (scenario === 'cancelled') timer = setTimeout(() => controller.abort(), 9000);
        await delay(12000, undefined, { signal: controller.signal });
      },
    });
    assert.equal(result.status, scenario === 'expired' ? 'failed' : scenario, JSON.stringify(result));
    const manifest = JSON.parse(await readFile(join(result.runDirectory, 'captures/screen-segments.json'), 'utf8'));
    assert.equal(manifest.status, scenario === 'expired' ? 'failed' : 'passed');
    assert(manifest.segments.length >= (scenario === 'expired' ? 1 : 2));
    for (const segment of manifest.segments) {
      const record = JSON.parse(await readFile(join(result.runDirectory, 'captures', `${segment.path}.capture.json`), 'utf8'));
      assert.equal(record.cleaned, true);
    }
    records.push({ scenario, result, manifest });
  } finally { clearTimeout(timer); }
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', records }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
