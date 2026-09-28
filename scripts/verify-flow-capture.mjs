import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runAndroidFlow } from '../packages/android/dist/flow.js';

const device = process.argv[2];
assert(device, 'Specify device');
const root = resolve('.appvanta/runs', `flow-capture-check-${Date.now()}`);
await mkdir(root, { recursive: true });
const records = [];
for (const scenario of ['passed', 'failed', 'cancelled', 'expired']) {
  const controller = new AbortController();
  let timer;
  const flow = { name: `Capture ${scenario}`, capture: { screenSeconds: scenario === 'expired' ? 1 : 60, perfettoSeconds: 60 }, steps: [{
    description: 'Check application process', action: { kind: 'wait', condition: { kind: 'app-running', packageName: scenario === 'passed' || scenario === 'expired' ? 'net.gsantner.markor' : 'appvanta.nonexistent.app' }, timeoutMs: scenario === 'cancelled' ? 30000 : 500 },
  }] };
  let result;
  try {
    result = await runAndroidFlow(device, flow, controller.signal, async run => {
      if (scenario === 'cancelled') {
        // Wait for both initialized collectors and a recorded action before cancelling.
        timer = setInterval(async () => {
          try { if ((await readFile(join(run, 'actions.jsonl'), 'utf8')).includes('started')) controller.abort(); } catch {}
        }, 100);
      }
    });
  } finally { clearInterval(timer); }
  assert.equal(result.status, scenario === 'expired' ? 'failed' : scenario, JSON.stringify(result));
  const summary = JSON.parse(await readFile(join(result.runDirectory, 'captures/summary.json'), 'utf8'));
  assert.equal(summary.status, scenario === 'expired' ? 'failed' : 'passed', JSON.stringify(summary));
  if (scenario !== 'expired') {
    assert.equal(summary.records.length, 2);
    for (const record of summary.records) {
      const bytes = await readFile(join(result.runDirectory, record.path));
      assert(bytes.length > 1024, 'Empty capture');
      if (record.kind === 'screen') assert(bytes.includes(Buffer.from('moov')), 'Video was not finalized');
    }
  }
  for (const file of (await readdir(join(result.runDirectory, 'captures'))).filter(name => name.endsWith('.capture.json'))) {
    const evidence = JSON.parse(await readFile(join(result.runDirectory, 'captures', file), 'utf8'));
    assert.equal(evidence.cleaned, true, JSON.stringify(evidence));
  }
  records.push({ scenario, result, summary });
}
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', records }, null, 2));
console.log(JSON.stringify({ status: 'passed', root }));
