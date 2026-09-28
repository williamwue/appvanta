import { recordingDriver } from './recording.js';
import { fingerprintProgressEvidence, type ProgressEvidenceHashes } from './flow-progress.js';
import { recoverStep } from './recovery.js';
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { brand } from './domain.js';
import type { Condition, DeviceDriver, DeviceId, Observation } from './domain.js';
import type { FlowDefinition, FlowStep, NetworkConfig, CaptureConfig, DiagnosticsConfig, FileFixture, AppOpFixture, PermissionFixture } from './flow-schema.js';
import type { RunContext } from './run.js';
import { writeMarkdownReport } from './report.js';
import type { ReportStep } from './report.js';

export interface FlowDriver extends DeviceDriver {
  openUrl(deviceId: DeviceId, url: string): Promise<void>;
  checkCondition(deviceId: DeviceId, condition: Condition, observation?: Observation): Promise<boolean>;
}
export interface FlowOptions {
  readonly context: RunContext;
  readonly driver: FlowDriver;
  readonly flow: FlowDefinition;
  readonly signal?: AbortSignal;
  readonly resetAppData?: (packages: readonly string[], serial: string, root: string, signal?: AbortSignal) => Promise<void>;
  readonly startAppOps?: (settings: readonly AppOpFixture[], serial: string, root: string, signal?: AbortSignal) => Promise<{ stop(): Promise<void> }>;
  readonly startPermissions?: (settings: readonly PermissionFixture[], serial: string, root: string, signal?: AbortSignal) => Promise<{ stop(): Promise<void> }>;
  readonly startInputMethod?: (component: string, serial: string, root: string, signal?: AbortSignal) => Promise<{ stop(): Promise<void> }>;
  readonly startFixtures?: (files: readonly FileFixture[], serial: string, root: string, signal?: AbortSignal) => Promise<{ stop(): Promise<void> }>;
  readonly collectEnvironment?: () => Promise<unknown>;
  readonly startDiagnostics?: (config: DiagnosticsConfig, serial: string, root: string) => Promise<{ stop(): Promise<void> }>;
  readonly startCapture?: (config: CaptureConfig, serial: string, root: string) => Promise<FlowCaptureSession>;
  readonly startNetwork?: (config: NetworkConfig, serial: string, root: string, signal?: AbortSignal) => Promise<{ stop(): Promise<void> }>;
  readonly drainInstructions?: () => Promise<readonly { readonly id: string; readonly step: FlowStep }[]>;
  readonly finishInstruction?: (id: string, status: 'applied' | 'failed', error?: string) => Promise<void>;
  readonly beforeStep?: () => Promise<void>;
}
export interface FlowCaptureSession {
  stop(): Promise<void>;
  markStep?(index: number, phase: 'begin' | 'end'): Promise<void>;
}

/** The sole Flow execution path for both interactive and asynchronous adapters. */
export async function executeFlow({ context, driver, flow, signal, resetAppData, startNetwork, startCapture, startDiagnostics, collectEnvironment, startFixtures, startInputMethod, startPermissions, startAppOps, drainInstructions, finishInstruction, beforeStep }: FlowOptions) {
  const root = context.rootDirectory;
  const deviceId = context.device.id;
  const steps: ReportStep[] = [];
  let recordingStep = 0;
  driver = await recordingDriver(driver, root, () => recordingStep);
  const save = (name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value, null, 2));
  const evidence = (o?: Observation) => [o?.screenshotPath, o?.uiTreePath, o?.uiDescriptionPath].filter((p): p is string => !!p).map(p => relative(root, p).replaceAll('\\', '/'));
  const append = async (record: ReportStep) => { steps.push(record); await context.evidence.appendStep(record); };
  await save('flow.json', flow);
  await save('device.json', context.device);
  await save('run.json', { ...context.metadata, status: 'running' });
  await context.evidence.savePlan(`# ${flow.name}\n\n${flow.description ?? ''}\n\n${flow.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}\n`);
  let session: { stop(): Promise<void> } | undefined;
  let capture: FlowCaptureSession | undefined;
  let diagnostics: { stop(): Promise<void> } | undefined;
  let fixtures: { stop(): Promise<void> } | undefined;
  let inputMethod: { stop(): Promise<void> } | undefined;
  let permissions: { stop(): Promise<void> } | undefined;
  let appOps: { stop(): Promise<void> } | undefined;
  let setupFailed = false;
  let cleanupFailed = false;
  let progressError: unknown;
  let expectedStepCount = flow.steps.length;
  type PendingStep = { step: FlowStep; instructionId?: string; flowIndex?: number };
  const pending: PendingStep[] = flow.steps.map((step, flowIndex) => ({ step, flowIndex }));
  const completed: { item: PendingStep; result: ReportStep; evidenceSha256: ProgressEvidenceHashes }[] = [];
  let active: PendingStep | undefined;
  let revision = 0;
  const progress = async (phase: 'setup' | 'boundary' | 'executing' | 'finalizing' | 'finished', status?: string) => {
    const temporary = join(root, `progress-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ version: 1, revision: ++revision, deviceId, flowSha256: createHash('sha256').update(JSON.stringify(flow)).digest('hex'), phase, active, completed, pending, status, updatedAt: new Date().toISOString() }, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, join(root, 'progress.json'));
  };
  await progress('setup');
  try {
    signal?.throwIfAborted();
    if (collectEnvironment) await save('environment.json', await collectEnvironment());
    if (flow.resetApplications) {
      if (!resetAppData) throw new Error('Application data reset is not supported by this adapter');
      await resetAppData(flow.resetApplications, deviceId, root, signal);
    }
    if (flow.files) {
      if (!startFixtures) throw new Error('File fixtures are not supported by this adapter');
      fixtures = await startFixtures(flow.files, deviceId, root, signal);
    }
    if (flow.inputMethod) {
      if (!startInputMethod) throw new Error('Input method fixture is not supported by this adapter');
      inputMethod = await startInputMethod(flow.inputMethod, deviceId, root, signal);
    }
    if (flow.permissions) {
      if (!startPermissions) throw new Error('Runtime permission fixtures are not supported by this adapter');
      permissions = await startPermissions(flow.permissions, deviceId, root, signal);
    }
    if (flow.appOps) {
      if (!startAppOps) throw new Error('AppOps fixtures are not supported by this adapter');
      appOps = await startAppOps(flow.appOps, deviceId, root, signal);
    }
    if (flow.diagnostics) {
      if (!startDiagnostics) throw new Error('Diagnostics is not supported by this adapter');
      diagnostics = await startDiagnostics(flow.diagnostics, deviceId, root);
    }
    if (flow.network) {
      if (!startNetwork) throw new Error('Network session is not supported by this adapter');
      session = await startNetwork(flow.network, deviceId, root, signal);
    }
    if (flow.capture) {
      if (!startCapture) throw new Error('Capture session is not supported by this adapter');
      capture = await startCapture(flow.capture, deviceId, root);
    }
    for (let index = 0; ; index++) {
      const injected = await drainInstructions?.() ?? [];
      expectedStepCount += injected.length;
      pending.unshift(...injected.map(item => ({ step: item.step, instructionId: item.id })));
      const next = pending.shift();
      if (!next) break;
      active = next;
      await progress('boundary');
      const definition = next.step;
      recordingStep = index + 1;
      const started = Date.now();
      let observation: Observation | undefined;
      const recoveryEvidence: string[] = [];
      let marked = false;
      const verify = async () => {
        const deadline = Date.now() + (definition.timeoutMs ?? 5000);
        do {
          signal?.throwIfAborted();
          observation = await driver.observe(deviceId);
          const textOk = !definition.assertText || await driver.checkCondition(deviceId, { kind: 'text-visible', text: definition.assertText }, observation);
          const targetOk = !definition.assertTarget || await driver.checkCondition(deviceId, { kind: 'target-visible', target: definition.assertTarget }, observation);
          if (textOk && targetOk) break;
          if (Date.now() >= deadline) throw new Error(`Checkpoint failed: ${definition.assertText ?? JSON.stringify(definition.assertTarget)}`);
          await delay(Math.min(200, deadline - Date.now()), undefined, { signal });
        } while (true);
      };
      try {
        await beforeStep?.();
        signal?.throwIfAborted();
        await progress('executing');
        await capture?.markStep?.(index + 1, 'begin');
        marked = true;
        observation = await driver.observe(deviceId);
        await context.evidence.saveObservation(`before-${index + 1}`, observation);
        if (definition.launchPackage) await driver.launch(deviceId, brand<string, 'AppPackageName'>(definition.launchPackage));
        if (definition.openUrl) await driver.openUrl(deviceId, definition.openUrl);
        if (definition.action) {
          const actionResult = await driver.execute(deviceId, definition.action);
          if (!actionResult.success) throw new Error(actionResult.message ?? 'Device action failed');
        }
        await verify();
        signal?.throwIfAborted();
        await append({ index: index + 1, description: definition.description, status: 'passed', ...(definition.echo ? { output: definition.echo } : {}), evidence: evidence(observation), durationMs: Date.now() - started });
        if (next.instructionId) await finishInstruction?.(next.instructionId, 'applied');
      } catch (error) {
        let message = String(error);
        let recovered = false;
        if (!signal?.aborted) {
          try {
            observation = await driver.observe(deviceId);
            await context.evidence.saveObservation(`failure-${index + 1}`, observation);
            if (definition.recovery) {
              recoveryEvidence.push(...evidence(observation), 'recovery.jsonl');
              const attempts = await recoverStep({ context, driver, policy: definition.recovery, step: index + 1, signal, verify,
                observe: current => { observation = current; recoveryEvidence.push(...evidence(current)); } });
              recovered = true;
              message += `; recovered after ${attempts} declared operation(s), original checkpoint passed`;
            }
          } catch (recoveryError) {
            message += `; re-observation/recovery failed: ${String(recoveryError)}`;
            if (definition.recovery && !signal?.aborted) {
              try {
                observation = await driver.observe(deviceId);
                await context.evidence.saveObservation(`recovery-failure-${index + 1}`, observation);
              } catch (captureError) { message += `; final capture failed: ${String(captureError)}`; }
            }
          }
        }
        await append({ index: index + 1, description: definition.description, status: signal?.aborted ? 'cancelled' : recovered ? 'passed' : 'failed', message,
          evidence: [...new Set([...evidence(observation), ...recoveryEvidence])], durationMs: Date.now() - started });
        if (next.instructionId) await finishInstruction?.(next.instructionId, recovered ? 'applied' : 'failed', message);
        if (recovered && !signal?.aborted) continue;
        break;
      } finally {
        if (marked) await capture?.markStep?.(index + 1, 'end');
        const result = steps.at(-1);
        if (result?.index === index + 1 && result.status === 'passed') {
          const evidenceSha256 = await fingerprintProgressEvidence(root, result.evidence ?? []);
          completed.push({ item: next, result, evidenceSha256 });
          active = undefined;
          await progress('boundary');
        }
      }
    }
  } catch (error) {
    setupFailed = true;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'APPVANTA_RESTORATION_UNVERIFIED') cleanupFailed = true;
    await append({ index: steps.length + 1, description: 'Initialize Flow resources', status: signal?.aborted ? 'cancelled' : 'failed', message: String(error), evidence: flow.resetApplications ? ['fixtures/app-data-reset.json'] : [] });
  } finally {
    try { await progress('finalizing'); } catch (error) { cleanupFailed = true; progressError = error; }
    if (capture) try { await capture.stop(); } catch (error) {
      cleanupFailed = true;
      await append({ index: steps.length + 1, description: 'Finalize Flow capture', status: 'failed', message: String(error), evidence: ['captures/summary.json'] });
    }
    if (session) try { await session.stop(); } catch (error) {
      cleanupFailed = true;
      await append({ index: steps.length + 1, description: 'Finalize network capture', status: 'failed', message: String(error), evidence: ['network/summary.json', 'logs/network-session.txt'] });
    }
  }
  if (diagnostics) try { await diagnostics.stop(); } catch (error) {
    cleanupFailed = true;
    await append({ index: steps.length + 1, description: 'Runtime diagnostics', status: 'failed', message: String(error), evidence: ['diagnostics/summary.json'] });
  }
  if (appOps) try { await appOps.stop(); } catch (error) {
    cleanupFailed = true;
    await append({ index: steps.length + 1, description: 'Restore AppOps', status: 'failed', message: String(error), evidence: ['fixtures/appops.json'] });
  }
  if (permissions) try { await permissions.stop(); } catch (error) {
    cleanupFailed = true;
    await append({ index: steps.length + 1, description: 'Restore runtime permissions', status: 'failed', message: String(error), evidence: ['fixtures/permissions.json'] });
  }
  if (inputMethod) try { await inputMethod.stop(); } catch (error) {
    cleanupFailed = true;
    await append({ index: steps.length + 1, description: 'Restore input method', status: 'failed', message: String(error), evidence: ['fixtures/input-method.json'] });
  }
  if (fixtures) try { await fixtures.stop(); } catch (error) {
    cleanupFailed = true;
    await append({ index: steps.length + 1, description: 'Restore file fixtures', status: 'failed', message: String(error), evidence: ['fixtures/summary.json'] });
  }
  if (progressError) await append({ index: steps.length + 1, description: 'Save Flow progress', status: 'failed', message: String(progressError), evidence: [] });
  const status = cleanupFailed ? 'failed' : signal?.aborted ? 'cancelled' : !setupFailed && steps.length === expectedStepCount && steps.every(s => s.status === 'passed') ? 'passed' : 'failed';
  const recording: Record<string, string> = {};
  for (const name of ['actions.jsonl', 'flow.json', 'steps.jsonl']) recording[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex');
  if (collectEnvironment && !setupFailed) recording['environment.json'] = createHash('sha256').update(await readFile(join(root, 'environment.json'))).digest('hex');
  const metadata = { ...context.metadata, recording, status, finishedAt: new Date().toISOString() } as const;
  const report = await writeMarkdownReport(root, { metadata, deviceName: context.device.name, steps });
  if (flow.network) await writeFile(report, '\n## Network evidence\n\n- [Requests](network/requests.jsonl)\n- [Capture and proxy restoration](network/summary.json)\n- [Proxy diagnostics](network/proxy.log)\n', { flag: 'a' });
  if (flow.capture) await writeFile(report, '\n## Capture evidence\n\n- [Capture summary](captures/summary.json)\n', { flag: 'a' });
  if (flow.diagnostics) await writeFile(report, '\n## Runtime diagnostics\n\n- [Diagnostics summary](diagnostics/summary.json)\n', { flag: 'a' });
  if (flow.files) await writeFile(report, '\n## File fixtures\n\n- [Preparation and restoration](fixtures/summary.json)\n', { flag: 'a' });
  if (flow.inputMethod) await writeFile(report, '\n## Input method fixture\n\n- [Selection and restoration](fixtures/input-method.json)\n', { flag: 'a' });
  if (flow.appOps) await writeFile(report, '\n## AppOps fixtures\n\n- [Preparation and restoration](fixtures/appops.json)\n', { flag: 'a' });
  if (flow.permissions) await writeFile(report, '\n## Runtime permission fixtures\n\n- [Preparation and restoration](fixtures/permissions.json)\n', { flag: 'a' });
  if (flow.resetApplications) await writeFile(report, '\n## Application data reset\n\n- [Destructive reset record](fixtures/app-data-reset.json)\n', { flag: 'a' });
  await save('run.json', metadata);
  await save('report.json', { metadata, deviceName: context.device.name, steps });
  await progress('finished', status);
  return { status, runDirectory: root, report, steps, cleanupFailed } as const;
}
