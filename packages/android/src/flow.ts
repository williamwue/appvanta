import { startAppOps } from './appops-fixture.js';
import { startImeFixture } from './ime-fixture.js';
import { startFileFixtures } from './file-fixtures.js';
import { collectFlowEnvironment } from './environment.js';
import { startFlowDiagnostics } from './flow-diagnostics.js';
import { startFlowCapture } from './flow-capture.js';
import { resolve, relative } from 'node:path';
import { bindDeviceLockRun, createRunContext, executeFlow, inspectDeviceLock, parseFlow, retainDeviceLockForCleanup, withAndroidFlowDeviceLock, withDeviceLockAdmission, runOnDevices } from '@appvanta/core';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AdbDriver } from './adb-driver.js';
import { startNetwork } from './network-session.js';
import { startRuntimePermissions } from './permission-fixture.js';
import { resetApplicationData } from './app-data-reset.js';
import { recoverEmulatorShakes } from './emulator-sensors.js';
import { parseAction } from '@appvanta/core';

/** Execute one action with the same durable binding and cleanup as a Flow. */
export async function runAndroidAction(serial: string, input: unknown, signal?: AbortSignal) {
  const action = parseAction(input);
  const startedAt = new Date().toISOString();
  const result = await runAndroidFlow(serial, { name: `Android action: ${action.kind}`, steps: [{ description: `Execute ${action.kind}`, action }] }, signal);
  return { success: result.status === 'passed', startedAt, finishedAt: new Date().toISOString(),
    status: result.status, runDirectory: result.runDirectory, report: result.report, cleanupFailed: result.cleanupFailed,
    ...(result.status !== 'passed' ? { message: result.steps.filter(step => step.status !== 'passed').map(step => step.message ?? step.description).join('; ') } : {}) };
}

/** onRunCreated may persist run/task metadata only. It must reject if that
 * persistence is incomplete; device or other external changes belong in a
 * separately admitted operation with a verified restoration postcondition.
 */
export async function runAndroidFlow(serial: string, input: unknown, signal?: AbortSignal, onRunCreated?: (root: string) => Promise<void>, instructions?: { drain(): Promise<readonly { readonly id: string; readonly step: import('@appvanta/core').FlowStep }[]>; finish(id: string, status: 'applied' | 'failed', error?: string): Promise<void>; beforeStep?(): Promise<void> }) {
  const flow = parseFlow(input);
  return withAndroidFlowDeviceLock(serial, async () => {
  signal?.throwIfAborted();
  const driver = new AdbDriver({ artifactsDirectory: resolve('.appvanta/probe'), ...(signal ? { signal } : {}) });
  const device = (await driver.listDevices()).find(d => d.id === serial && d.status === 'online');
  if (!device) throw new Error(`Device not found or offline: ${serial}`);
  const context = await createRunContext({ runsDirectory: resolve('.appvanta/runs'), driver, device: { ...device, ...await driver.deviceEnvironment(device.id) } });
  await bindDeviceLockRun(serial, context.rootDirectory, undefined, 'android-flow');
  try { if (onRunCreated) await withDeviceLockAdmission(serial, () => onRunCreated(context.rootDirectory)); }
  catch (error) {
    try {
      const state = await inspectDeviceLock(serial);
      if (!state || !state.lease.runDirectory || await realpath(context.rootDirectory) !== state.lease.runDirectory) throw new Error('Pre-Flow lease binding changed');
      const runDirectory = state.lease.runDirectory;
      await writeFile(resolve(runDirectory, 'pre-flow-failure.json'), JSON.stringify({ version: 1, scope: 'run-created-callback', deviceId: serial, token: state.lease.token, runDirectory, error: String(error) }, null, 2), { flag: 'wx' });
    } catch (evidenceError) {
      throw new AggregateError([error, evidenceError], 'Run creation callback and pre-Flow failure evidence both failed');
    }
    throw error;
  }
  const sensorRecoveryDirectory = resolve(context.rootDirectory, 'fixtures', 'emulator-sensors');
  const flowDriver = new AdbDriver({ artifactsDirectory: resolve(context.rootDirectory, 'artifacts'), sensorRecoveryDirectory, ...(signal ? { signal } : {}) });
  const result = await executeFlow({ context, driver: flowDriver, flow, restoreActionState: () => recoverEmulatorShakes('adb', serial, sensorRecoveryDirectory), resetAppData: resetApplicationData, startAppOps, startPermissions: startRuntimePermissions, startInputMethod: startImeFixture, startFixtures: startFileFixtures, collectEnvironment: () => collectFlowEnvironment(flowDriver, device.id, flow), startNetwork, startCapture: startFlowCapture, startDiagnostics: startFlowDiagnostics, ...(instructions ? { drainInstructions: () => instructions.drain(), finishInstruction: (id: string, status: 'applied' | 'failed', error?: string) => instructions.finish(id, status, error), ...(instructions.beforeStep ? { beforeStep: () => instructions.beforeStep!() } : {}) } : {}), ...(signal ? { signal } : {}) });
  if (result.cleanupFailed) await retainDeviceLockForCleanup(serial, result.runDirectory);
  return result;
  });
}

export async function runAndroidFlows(deviceIds: readonly string[], input: unknown, concurrency = 2, signal?: AbortSignal) {
  const startedAt = new Date().toISOString();
  const flow = parseFlow(input);
  // Proxy sessions bind one host port. Serialize network-enabled batches until
  // port allocation and per-device host routing are available.
  if (flow.network && concurrency !== 1) throw new Error('Network-enabled batches require concurrency 1');
  const results = await runOnDevices(deviceIds, id => runAndroidFlow(id, flow, signal), { concurrency, ...(signal ? { signal } : {}), status: result => result.status });
  const directory = resolve('.appvanta/runs', `batch-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true });
  const status = results.some(r => r.status === 'failed') ? 'failed' : results.some(r => r.status === 'cancelled') ? 'cancelled' : 'passed';
  const summary = { version: 1, status, concurrency, results, startedAt, finishedAt: new Date().toISOString() };
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(resolve(directory, 'flow.json'), JSON.stringify(flow, null, 2));
  await mkdir(resolve(directory, 'devices'));
  for (const [index, result] of results.entries()) await writeFile(resolve(directory, 'devices', `${index + 1}.json`), JSON.stringify(result, null, 2));
  const escape = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = results.map((result, index) => {
    const report = result.value ? `[Report](${relative(directory, result.value.report).replaceAll('\\', '/')})` : '';
    return `| ${escape(result.deviceId)} | ${result.status} | [Result](devices/${index + 1}.json) ${report} | ${escape(result.error ?? '')} |`;
  }).join('\n');
  await writeFile(resolve(directory, 'report.md'), `# AppVanta device batch\n\nResult: **${status}**\n\n| Device | Status | Evidence | Error |\n|---|---|---|---|\n${rows}\n`);
  return { ...summary, runDirectory: directory };
}
