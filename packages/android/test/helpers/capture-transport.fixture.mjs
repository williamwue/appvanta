import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let scenario;
const timeout = () => Object.assign(new Error('injected ownership probe timeout'), { code: null, killed: true, signal: 'SIGTERM' });
mock.module('node:child_process', { namedExports: {
  ...childProcess,
  execFile: (_file, args, _options, callback) => {
    queueMicrotask(async () => {
      try {
        const operation = args[2];
        if (operation === 'pull') {
          scenario.pulls++;
          if (scenario.pullFails) throw Object.assign(new Error('injected adb pull failure'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' });
          await writeFile(args[4], scenario.emptyPull || (scenario.emptyLogPull && args[3].endsWith('.log')) ? '' : 'nonempty artifact');
          if (scenario.abortOnPull) scenario.abortController.abort(new Error('injected cancellation during pull'));
          callback(null, { stdout: '', stderr: '' });
          return;
        }
        const command = String(args[3]);
        scenario.commands.push(command);
        let stdout = '';
        if (command.startsWith('nohup ')) {
          scenario.remote = command.match(/\/sdcard\/screen-[a-f0-9-]+\.mp4/)?.[0];
        } else if (command.startsWith('if [ -f ') && command.includes('.status')) {
          stdout = scenario.exitStatus ?? '0';
        } else if (command.startsWith('cat ') && command.endsWith('.log')) {
          stdout = 'injected capture process failure';
        } else if (command.startsWith('for n in') && command.includes('.pid')) {
          stdout = '123';
        } else if (command.startsWith('if [ -s ') && command.includes('.pid')) {
          stdout = '123';
        } else if (command.startsWith('if [ -r /proc/')) {
          scenario.probes++;
          if (scenario.probeError) throw Object.assign(new Error('injected non-timeout probe failure'), { code: 'EIO', killed: false, signal: null });
          if (scenario.probes <= (scenario.probeTimeouts ?? 0)) throw timeout();
          stdout = scenario.owned ? scenario.remote : '/sdcard/unrelated.mp4';
        } else if (command.startsWith('case ') && command.includes('kill -')) {
          scenario.kills++;
          scenario.owned = false;
        } else if (command.startsWith('if [ -f ') && command.includes('/sdcard/')) {
          stdout = scenario.missingRemote ? '' : 'present';
        } else if (command.startsWith('rm -f ')) {
          scenario.removes++;
        }
        callback(null, { stdout, stderr: '' });
      } catch (error) { callback(error); }
    });
  },
} });

const { captureArtifact, recoverCaptures } = await import('../../dist/capture.js');
const root = await mkdtemp(join(tmpdir(), 'appvanta-capture-transport-'));
let sequence = 0;
const run = async options => {
  const abortController = new AbortController();
  scenario = { owned: true, probes: 0, kills: 0, pulls: 0, removes: 0, commands: [], abortController, ...options };
  const directory = join(root, String(++sequence));
  let error;
  try { await captureArtifact('fake-adb', 'device', directory, 'screen', 1, abortController.signal); }
  catch (caught) { error = caught; }
  const evidenceName = (await readdir(directory)).find(name => name.endsWith('.capture.json'));
  const evidence = JSON.parse(await readFile(join(directory, evidenceName), 'utf8'));
  return { state: scenario, evidence, error, path: join(directory, evidence.artifact) };
};

const assertPullError = (evidence, phase) => {
  const detail = evidence.transportErrors.at(-1);
  const { phase: actualPhase, attempt, code, killed, signal } = detail;
  assert.deepEqual({ phase: actualPhase, attempt, code, killed, signal },
    { phase, attempt: 1, code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' });
  assert.ok(detail.elapsedMs >= 0);
};

const assertMissingArtifact = (evidence, phase) => {
  const detail = evidence.transportErrors.at(-1);
  assert.equal(detail.phase, phase);
  assert.equal(detail.attempt, 0);
  assert.equal(detail.code, 'ENOENT');
  assert.equal(detail.killed, false);
  assert.equal(detail.signal, null);
  assert.ok(detail.elapsedMs >= 0);
};

try {
  const retried = await run({ probeTimeouts: 1 });
  assert.equal(retried.error, undefined);
  assert.equal(retried.evidence.status, 'passed');
  assert.equal(retried.evidence.cleaned, true);
  assert.ok(retried.state.probes >= 3);
  assert.equal(retried.state.kills, 1);
  assert.equal(retried.state.removes, 1);
  assert.deepEqual(retried.evidence.transportErrors.map(({ phase, attempt, code, killed, signal }) => ({ phase, attempt, code, killed, signal })),
    [{ phase: 'capture-ownership', attempt: 1, code: null, killed: true, signal: 'SIGTERM' }]);
  assert.ok(retried.evidence.transportErrors[0].elapsedMs >= 0);

  const stalled = await run({ probeTimeouts: 2 });
  assert.equal(stalled.error.code, 'APPVANTA_RESTORATION_UNVERIFIED');
  assert.equal(stalled.evidence.cleaned, false);
  assert.equal(stalled.state.probes, 2);
  assert.equal(stalled.state.kills, 0);
  assert.equal(stalled.state.pulls, 0);
  assert.equal(stalled.state.removes, 0);
  assert.equal(stalled.evidence.transportErrors.length, 2);
  assert.equal(stalled.evidence.remote, stalled.state.remote);
  assert.ok(stalled.evidence.control);

  const probeFailed = await run({ probeError: true });
  assert.equal(probeFailed.state.probes, 1);
  assert.equal(probeFailed.evidence.transportErrors[0].code, 'EIO');
  assert.equal(probeFailed.evidence.cleaned, false);
  assert.equal(probeFailed.state.removes, 0);

  const reused = await run({ owned: false });
  assert.equal(reused.error, undefined);
  assert.equal(reused.state.kills, 0);
  assert.equal(reused.evidence.cleaned, true);

  const pullFailed = await run({ pullFails: true });
  assert.equal(pullFailed.error.code, 'APPVANTA_RESTORATION_UNVERIFIED');
  assert.match(String(pullFailed.error.errors[0]), /injected adb pull failure/);
  assert.equal(pullFailed.evidence.cleaned, false);
  assert.equal(pullFailed.state.removes, 0);
  assert.equal(pullFailed.state.pulls, 1);
  assert.equal(pullFailed.evidence.remote, pullFailed.state.remote);
  assertPullError(pullFailed.evidence, 'capture-pull');

  const zeroBytes = await run({ emptyPull: true });
  assert.equal(zeroBytes.error.code, 'APPVANTA_RESTORATION_UNVERIFIED');
  assert.equal(zeroBytes.evidence.status, 'failed');
  assert.equal(zeroBytes.evidence.cleaned, false);
  assert.equal(zeroBytes.state.removes, 0);
  assert.equal(zeroBytes.evidence.transportErrors.at(-1).phase, 'capture-pull');

  const captureMissing = await run({ missingRemote: true });
  assert.equal(captureMissing.error.code, 'APPVANTA_RESTORATION_UNVERIFIED');
  assert.match(captureMissing.evidence.error, /Capture artifact absent/);
  assert.equal(captureMissing.evidence.status, 'failed');
  assert.equal(captureMissing.evidence.cleaned, false);
  assert.equal(captureMissing.state.pulls, 0);
  assert.equal(captureMissing.state.removes, 0);
  assertMissingArtifact(captureMissing.evidence, 'capture-pull');

  const cancelledPull = await run({ abortOnPull: true });
  assert.match(String(cancelledPull.error), /injected cancellation during pull/);
  assert.equal(cancelledPull.evidence.status, 'failed');
  assert.equal(cancelledPull.evidence.cancelled, true);
  assert.equal(cancelledPull.evidence.cleaned, true);
  assert.equal(cancelledPull.state.removes, 1);
  assert.equal(await readFile(cancelledPull.path, 'utf8'), 'nonempty artifact');

  const originalFailure = await run({ exitStatus: '1', pullFails: true });
  assert.match(String(originalFailure.error.errors[0]), /Capture exited 1/);
  assert.match(originalFailure.evidence.error, /Capture exited 1/);
  assert.equal(originalFailure.evidence.cleaned, false);
  assert.equal(originalFailure.state.removes, 0);

  const recover = async (record, options) => {
    scenario = { owned: true, probes: 0, kills: 0, pulls: 0, removes: 0, commands: [], remote: record.remote, ...options };
    const runDirectory = join(root, `recovery-${++sequence}`);
    const captures = join(runDirectory, 'captures');
    await mkdir(captures, { recursive: true });
    const evidencePath = join(captures, `${record.artifact}.capture.json`);
    await writeFile(evidencePath, JSON.stringify(record));
    let error;
    try { await recoverCaptures('fake-adb', 'device', runDirectory); }
    catch (caught) { error = caught; }
    return { state: scenario, evidence: JSON.parse(await readFile(evidencePath, 'utf8')), error };
  };
  const recoveryStalled = await recover(stalled.evidence, { probeTimeouts: 2 });
  assert.match(String(recoveryStalled.error), /injected ownership probe timeout/);
  assert.equal(recoveryStalled.evidence.cleaned, false);
  assert.equal(recoveryStalled.state.probes, 2);
  assert.equal(recoveryStalled.state.kills, 0);
  assert.equal(recoveryStalled.state.pulls, 0);
  assert.equal(recoveryStalled.state.removes, 0);
  assert.equal(recoveryStalled.evidence.transportErrors.at(-1).phase, 'recovery-ownership');

  const recoveryRetried = await recover(stalled.evidence, { probeTimeouts: 1, emptyLogPull: true });
  assert.equal(recoveryRetried.error, undefined);
  assert.equal(recoveryRetried.evidence.status, 'recovered');
  assert.equal(recoveryRetried.evidence.cleaned, true);
  assert.equal(recoveryRetried.state.kills, 1);
  assert.equal(recoveryRetried.state.removes, 1);
  assert.equal(recoveryRetried.evidence.transportErrors.at(-1).phase, 'recovery-ownership');

  const recoveryReused = await recover(stalled.evidence, { owned: false });
  assert.equal(recoveryReused.error, undefined);
  assert.equal(recoveryReused.state.kills, 0);

  const recoveryPullFailed = await recover(stalled.evidence, { pullFails: true });
  assert.match(String(recoveryPullFailed.error), /injected adb pull failure/);
  assert.equal(recoveryPullFailed.evidence.status, 'failed');
  assert.equal(recoveryPullFailed.evidence.cleaned, false);
  assert.equal(recoveryPullFailed.state.removes, 0);
  assert.equal(recoveryPullFailed.state.pulls, 1);
  assertPullError(recoveryPullFailed.evidence, 'recovery-pull');

  const recoveryEmpty = await recover(stalled.evidence, { emptyPull: true });
  assert.match(String(recoveryEmpty.error), /Recovered capture transfer unverified/);
  assert.equal(recoveryEmpty.evidence.cleaned, false);
  assert.equal(recoveryEmpty.state.removes, 0);
  assert.equal(recoveryEmpty.evidence.transportErrors.at(-1).phase, 'recovery-pull');

  const recoveryMissing = await recover(stalled.evidence, { missingRemote: true });
  assert.equal(recoveryMissing.error.code, 'ENOENT');
  assert.equal(recoveryMissing.evidence.status, 'failed');
  assert.equal(recoveryMissing.evidence.cleaned, false);
  assert.equal(recoveryMissing.state.pulls, 0);
  assert.equal(recoveryMissing.state.removes, 0);
  assertMissingArtifact(recoveryMissing.evidence, 'recovery-pull');
  console.log('capture-transport: passed');
} finally { await rm(root, { recursive: true, force: true }); }
