#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from "node:path";
import { recoverAndroidFlow, analyzePerfetto, AdbDriver, runAndroidFlow, runAndroidFlows, parseUiTree, interactionCandidates, inspectAndroidEnvironment, startManualRecording, stopManualRecording } from "@appvanta/android";
import { inspectDeviceLock, verifyEvidence, checkPerformanceBaseline, recordedFlow, brand, createRunContext, writeMarkdownReport, compareRuns, exportEvidence, runOnDevices, checkBaseline, withDeviceLock, TaskStore, MonitorStore, BatchStore, AuditLog, auditedStateChange, comparePngScreenshots } from "@appvanta/core";
import type { Action, AppPackageName, DeviceId, Observation, Target } from "@appvanta/core";
import { readFlowFile } from './flow-file.js';
import { inspectFlowProgress, inspectTaskProgress } from '@appvanta/core';
import { continueAndroidTask } from '@appvanta/android';
import { listAndroidAvds } from '@appvanta/android';
import { startAndroidAvd } from '@appvanta/android';
import { previewUncertainTaskStep, recordUncertainStepAdjudication, prepareAdjudicatedTaskContinuation, reserveAdjudicatedSuccessor } from '@appvanta/core';
import { continueAdjudicatedAndroidTask, restartAdjudicatedAndroidTask } from '@appvanta/android';

const commandController = new AbortController();
const cancelCommand = () => commandController.abort(new Error('Command interrupted'));
process.once('SIGINT', cancelCommand);
process.once('SIGTERM', cancelCommand);
const driver = new AdbDriver({ artifactsDirectory: resolve(".appvanta", "cli-artifacts"), signal: commandController.signal });
const [command, ...args] = process.argv.slice(2);

const deviceCommands = new Set(['observe', 'install', 'launch', 'stop', 'clear-data', 'uninstall', 'run', 'logs', 'foreground', 'permission', 'grant-permission', 'diagnose', 'network', 'performance', 'reset', 'record', 'perfetto', 'proxy', 'explore', 'record-interactions']);
try {
  if (deviceCommands.has(command ?? '') && args[0]) await withDeviceLock(args[0], dispatch);
  else await dispatch();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  process.off('SIGINT', cancelCommand);
  process.off('SIGTERM', cancelCommand);
}
async function dispatch(): Promise<void> {
  switch (command) {
    case 'restart-adjudicated-task': {
      if (args.length !== 5) throw new Error('Usage: restart-adjudicated-task <predecessor-task-id> <successor-task-id> <receipt.json> <current-lease-token> <checkpoint.json>');
      const receipt = JSON.parse(await readFile(resolve(args[2]!), 'utf8'));
      const checkpoint = JSON.parse(await readFile(resolve(args[4]!), 'utf8'));
      printJson(await restartAdjudicatedAndroidTask(new TaskStore(resolve('.appvanta/tasks')), args[0]!, args[1]!, receipt, args[3]!, checkpoint, commandController.signal));
      break;
    }
    case 'preview-uncertain-task': {
      if (args.length !== 1) throw new Error('Usage: preview-uncertain-task <task-id>');
      printJson(await previewUncertainTaskStep(new TaskStore(resolve('.appvanta/tasks')), args[0]!));
      break;
    }
    case 'adjudicate-task':
    case 'prepare-adjudicated-task':
    case 'reserve-adjudicated-task':
    case 'continue-adjudicated-task': {
      if (args.length !== 2 && !(command === 'continue-adjudicated-task' && args.length === 3)) throw new Error(`Usage: ${command} <task-id> <request.json>${command === 'continue-adjudicated-task' ? ' [transfer-retry-token]' : ''}`);
      const request = JSON.parse(await readFile(resolve(args[1]!), 'utf8'));
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Request must be a JSON object');
      const store = new TaskStore(resolve('.appvanta/tasks'));
      if (command === 'adjudicate-task') printJson(await recordUncertainStepAdjudication(store, args[0]!, request));
      else if (command === 'prepare-adjudicated-task') printJson(await prepareAdjudicatedTaskContinuation(store, args[0]!, request));
      else if (command === 'reserve-adjudicated-task') printJson(await reserveAdjudicatedSuccessor(store, args[0]!, request));
      else printJson(await continueAdjudicatedAndroidTask(store, args[0]!, request, { signal: commandController.signal, ...(args[2] !== undefined ? { transferRetryToken: args[2] } : {}) }));
      break;
    }
    case 'list-avds': printJson(await listAndroidAvds()); break;
    case 'start-avd': {
      if (!args[0] || args.length > 4) throw new Error('Usage: start-avd <name> [even-port] [timeout-ms] [gpu-mode]');
      const result = await startAndroidAvd(args[0], args[1] === undefined ? 5554 : Number(args[1]), args[2] === undefined ? 120000 : Number(args[2]), args[3]);
      printJson(result); if (result.status !== 'ready') process.exitCode = 1; break;
    }
    case 'continue-task': {
      if (args.length !== 3) throw new Error('Usage: continue-task <task-id> <lease-token> <checkpoint.json>');
      const checkpoint = JSON.parse(await readFile(resolve(args[2]!), 'utf8'));
      printJson(await continueAndroidTask(new TaskStore(resolve('.appvanta/tasks')), args[0]!, args[1]!, checkpoint, commandController.signal));
      break;
    }
    case 'inspect-task-progress': {
      if (!args[0]) throw new Error('Usage: inspect-task-progress <task-id>');
      const result = await inspectTaskProgress(new TaskStore(resolve('.appvanta/tasks')), args[0]);
      printJson(result);
      if (!result.boundaryConsistent) process.exitCode = 1;
      break;
    }
    case 'inspect-flow-progress': {
      if (!args[0]) throw new Error('Usage: inspect-flow-progress <run-directory>');
      const result = await inspectFlowProgress(resolve(args[0]));
      printJson(result);
      if (!result.boundaryConsistent) process.exitCode = 1;
      break;
    }
    case 'recover-flow': {
      if (!args[0] || !args[1]) throw new Error('Usage: recover-flow <device-id> <lease-token>');
      printJson(await recoverAndroidFlow(args[0], args[1])); break;
    }
    case 'device-lock': {
      if (!args[0]) throw new Error('Usage: device-lock <device-id>');
      printJson(await inspectDeviceLock(args[0])); break;
    }
    case 'tasks': printJson(await new TaskStore(resolve('.appvanta/tasks')).list()); break;
    case 'task': {
      if (!args[0]) throw new Error('Usage: task <task-id>');
      printJson(await new TaskStore(resolve('.appvanta/tasks')).get(args[0])); break;
    }
    case 'cancel-task': {
      if (!args[0]) throw new Error('Usage: cancel-task <task-id>');
      printJson(await new TaskStore(resolve('.appvanta/tasks')).requestCancel(args[0])); break;
    }
    case 'pause-task': {
      if (!args[0]) throw new Error('Usage: pause-task <task-id>');
      printJson(await new TaskStore(resolve('.appvanta/tasks')).requestPause(args[0])); break;
    }
    case 'resume-task': {
      if (!args[0]) throw new Error('Usage: resume-task <task-id>');
      printJson(await new TaskStore(resolve('.appvanta/tasks')).requestResume(args[0])); break;
    }
    case 'monitors': printJson(await new MonitorStore(resolve('.appvanta/monitors')).list()); break;
    case 'monitor': {
      if (!args[0]) throw new Error('Usage: monitor <monitor-id>');
      printJson(await new MonitorStore(resolve('.appvanta/monitors')).get(args[0])); break;
    }
    case 'release-monitor': {
      if (!args[0]) throw new Error('Usage: release-monitor <monitor-id>');
      printJson(await new MonitorStore(resolve('.appvanta/monitors')).requestRelease(args[0])); break;
    }
    case 'batches': printJson(await new BatchStore(resolve('.appvanta/batches')).list()); break;
    case 'batch': {
      if (!args[0]) throw new Error('Usage: batch <batch-id>');
      printJson(await new BatchStore(resolve('.appvanta/batches')).get(args[0])); break;
    }
    case 'cancel-batch': {
      if (!args[0]) throw new Error('Usage: cancel-batch <batch-id>');
      printJson(await new BatchStore(resolve('.appvanta/batches')).requestCancel(args[0])); break;
    }
    case "doctor": await doctor(args[0]); break;
    case "list-devices": await printJson(await driver.listDevices()); break;
    case "observe": await observe(args[0]); break;
    case "install": await install(args[0], args[1]); break;
    case "launch": await launch(args[0], args[1]); break;
    case "stop": await stop(args[0], args[1]); break;
    case "clear-data": await clearData(args[0], args[1]); break;
    case "uninstall": await uninstall(args[0], args[1]); break;
    case "run": await run(args[0], args[1]); break;
    case "run-flow": await runFlow(args[0], args[1]); break;
    case "logs": await logs(args[0]); break;
    case "foreground": await foreground(args[0]); break;
    case "permission": await permission(args[0], args[1], args[2]); break;
    case "grant-permission": await grantPermission(args[0], args[1], args[2]); break;
    case "diagnose": await diagnose(args[0], args[1], args[2]); break;
    case "report": await report(args[0]); break;
    case "compare": await compare(args[0], args[1], args[2]); break;
    case 'visual-diff': {
      if (!args[0] || !args[1] || !args[2] || args.length > 6) throw new Error('Usage: visual-diff <baseline.png> <current.png> <diff.png> [channel-threshold] [max-mismatch-ratio] [ignore-regions.json]');
      const result = await comparePngScreenshots(resolve(args[0]), resolve(args[1]), resolve(args[2]), { ...(args[3] !== undefined ? { channelThreshold: Number(args[3]) } : {}), ...(args[4] !== undefined ? { maxMismatchRatio: Number(args[4]) } : {}), ...(args[5] !== undefined ? { ignoreRegions: JSON.parse(await readFile(resolve(args[5]), 'utf8')) } : {}) });
      printJson(result); if (result.status !== 'passed') process.exitCode = 1; break;
    }
    case 'verify-export': {
      if (!args[0]) throw new Error('Usage: verify-export <export-directory>');
      printJson(await verifyEvidence(args[0])); break;
    }
    case "export": await exportRun(args[0], args[1]); break;
    case "run-many": await runMany(args[0], args[1]); break;
    case "run-flows": await runFlows(args[0], args[1], args[2]); break;
    case "network": await network(args[0]); break;
    case "performance": await performance(args[0], args[1], args[2]); break;
    case "reset": await reset(args[0], args[1]); break;
    case "record": await record(args[0], args[1]); break;
    case 'record-interactions': await recordInteractions(args[0], args[1], args[2], args[3]); break;
    case 'analyze-perfetto': {
      if (!args[0] || !args[1]) throw new Error('Usage: analyze-perfetto <trace> <package> [python] [window-ms]');
      printJson(await analyzePerfetto({ trace: args[0], packageName: args[1], ...(args[2] ? { python: args[2] } : {}), ...(args[3] ? { windowMs: Number(args[3]) } : {}) })); break;
    }
    case "perfetto": await perfetto(args[0], args[1]); break;
    case "proxy": await proxy(args[0], args[1]); break;
    case "record-flow": await recordFlow(args[0], args[1]); break;
    case "baseline": await baseline(args[0], args[1]); break;
    case "explore": await explore(args[0]); break;
    default: printUsage(); process.exitCode = command ? 1 : 0;
  }
}

async function compare(baseline?: string, current?: string, mode?: string): Promise<void> {
  if (!baseline || !current) throw new Error("Usage: compare <baseline-run> <current-run>");
  if (mode !== undefined && mode !== "--steps-only") throw new Error("Unknown comparison option");
  const result = await compareRuns(resolve(baseline), resolve(current), { stepsOnly: mode === "--steps-only" });
  printJson(result);
  if (result.status !== "passed") process.exitCode = 1;
}

async function exportRun(run?: string, destination?: string): Promise<void> {
  if (!run || !destination) throw new Error("Usage: export <run> <destination>");
  printJson({ exported: await exportEvidence(resolve(run), resolve(destination)) });
}

async function runMany(serials?: string, packageName?: string): Promise<void> {
  if (!serials || !packageName) throw new Error('Usage: run-many <device1,device2,...> <package-name>');
  const result = await runAndroidFlows(serials.split(',').map(s => s.trim()), { name: 'Launch on devices', steps: [{ description: 'Launch and verify running app', launchPackage: packageName, action: { kind: 'wait', condition: { kind: 'app-running', packageName }, timeoutMs: 5000 } }] }, 2, commandController.signal);
  if (result.status !== 'passed') process.exitCode = 1;
  printJson(result);
}

async function runFlows(serials?: string, file?: string, concurrency?: string): Promise<void> {
  if (!serials || !file) throw new Error('Usage: run-flows <device1,device2,...> <flow.json> [concurrency]');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Batch interrupted'));
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await runAndroidFlows(serials.split(',').map(s => s.trim()), await readFlowFile(file), concurrency === undefined ? 2 : Number(concurrency), controller.signal);
    if (result.status !== 'passed') process.exitCode = 1;
    printJson(result);
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

async function network(serial?: string): Promise<void> {
  if (!serial) throw new Error("Usage: network <device>");
  printJson(await driver.collectNetwork(requireDevice(serial)));
}

async function performance(serial?: string, packageName?: string, scenario?: string): Promise<void> {
  if (!serial || !packageName) throw new Error("Usage: performance <device> <package-name>");
  printJson(await driver.collectPerformance(requireDevice(serial), brand<string, "AppPackageName">(packageName), scenario));
}

async function reset(serial?: string, packageName?: string): Promise<void> {
  if (!serial || !packageName) throw new Error("Usage: reset <device> <package-name>");
  const deviceId = requireDevice(serial);
  const pkg = brand<string, "AppPackageName">(packageName);
  await driver.stopApp(deviceId, pkg);
  await driver.clearAppData(deviceId, pkg);
  printJson({ success: true, deviceId: serial, packageName, reset: ["stop", "clear-data"] });
}

async function record(serial?: string, seconds?: string): Promise<void> {
  if (!serial) throw new Error("Usage: record <device> [seconds]");
  printJson(await driver.recordScreen(requireDevice(serial), seconds ? Number(seconds) : 5));
}

async function recordInteractions(serial?: string, packagesValue?: string, secondsValue?: string, option?: string): Promise<void> {
  if (!serial || !packagesValue || !secondsValue || (option !== undefined && option !== '--include-text')) throw new Error('Usage: record-interactions <device> <package1,package2> <seconds> [--include-text]');
  const seconds = Number(secondsValue);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error('Recording duration must be an integer from 1 to 3600 seconds');
  const packages = packagesValue.split(',').map(value => value.trim()).filter(Boolean), directory = resolve('.appvanta/manual-recordings');
  const session = await startManualRecording(process.env.ADB_PATH ?? 'adb', requireDevice(serial), packages, option === '--include-text', directory, commandController.signal);
  let primary: unknown;
  try { await delay(seconds * 1000, undefined, { signal: commandController.signal }); }
  catch (error) { primary = error; }
  try {
    const result = await stopManualRecording(process.env.ADB_PATH ?? 'adb', requireDevice(serial), session.recordingId, directory);
    if (!primary) printJson(result);
  } catch (cleanup) { throw new AggregateError(primary ? [primary, cleanup] : [cleanup], 'Manual recording cleanup failed'); }
  if (primary) throw primary;
}

async function perfetto(serial?: string, seconds?: string): Promise<void> {
  if (!serial) throw new Error("Usage: perfetto <device> [seconds]");
  printJson(await driver.collectPerfetto(requireDevice(serial), seconds ? Number(seconds) : 5));
}

async function proxy(serial?: string, value?: string): Promise<void> {
  if (!serial) throw new Error("Usage: proxy <device> [host:port|off]");
  const proxyValue = value && value !== "off" ? value : null;
  await driver.setHttpProxy(requireDevice(serial), proxyValue);
  printJson({ success: true, deviceId: serial, proxy: proxyValue });
}

async function recordFlow(run?: string, output?: string): Promise<void> {
  if (!run || !output) throw new Error("Usage: record-flow <run-directory> <output.json>");
  const flow = await recordedFlow(resolve(run));
  await writeFile(resolve(output), `${JSON.stringify(flow, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  printJson({ output: resolve(output), steps: flow.steps.length });
}

async function baseline(baselinePath?: string, currentPath?: string): Promise<void> {
  if (!baselinePath || !currentPath) throw new Error("Usage: baseline <baseline.json> <current.json>");
  const baselineValues: unknown = JSON.parse(await readFile(resolve(baselinePath), "utf8"));
  const currentValues: unknown = JSON.parse(await readFile(resolve(currentPath), "utf8"));
  if (!baselineValues || typeof baselineValues !== 'object' || !('version' in baselineValues)) throw new Error('Baseline version is required');
  let result;
  if (baselineValues.version === 2) result = checkPerformanceBaseline(baselineValues, currentValues);
  else if (baselineValues.version === 1 && 'values' in baselineValues) {
    result = { ...checkBaseline(baselineValues.values, currentValues), version: 1, warning: 'Legacy numeric comparison does not validate units or sampling; migrate to version 2' };
  } else throw new Error('Unsupported baseline version');
  printJson(result);
  if (!result.passed) process.exitCode = 1;
}

async function explore(serial?: string): Promise<void> {
  if (!serial) throw new Error("Usage: explore <device>");
  const observation = await driver.observe(requireDevice(serial));
  const xml = observation.uiTreePath ? await readFile(observation.uiTreePath, "utf8") : "";
  const tree = parseUiTree(xml);
  printJson({ observation, tree, candidates: interactionCandidates(tree).slice(0, 100) });
}

async function doctor(option?: string): Promise<void> {
  if (option !== undefined && option !== '--fix') throw new Error('Usage: doctor [--fix]');
  const result = await inspectAndroidEnvironment({ root: resolve('.'), fix: option === '--fix' });
  printJson(result);
  if (result.verdict === 'blocked') process.exitCode = 1;
}

async function observe(serial?: string): Promise<void> {
  const deviceId = requireDevice(serial);
  printJson(await driver.observe(deviceId));
}

async function install(serial?: string, apk?: string): Promise<void> {
  if (!apk) throw new Error("Usage: install <device> <apk>");
  const deviceId = requireDevice(serial);
  await driver.install(deviceId, { path: resolve(apk), format: "apk" });
  printJson({ success: true, deviceId, apk: resolve(apk) });
}

async function launch(serial?: string, packageName?: string): Promise<void> {
  if (!packageName) throw new Error("Usage: launch <device> <package-name>");
  const deviceId = requireDevice(serial);
  await driver.launch(deviceId, brand<string, "AppPackageName">(packageName));
  printJson({ success: true, deviceId, packageName });
}

async function stop(serial?: string, packageName?: string): Promise<void> {
  if (!packageName) throw new Error("Usage: stop <device> <package-name>");
  await driver.stopApp(requireDevice(serial), brand<string, "AppPackageName">(packageName));
  printJson({ success: true, operation: "stop", deviceId: serial, packageName });
}

async function clearData(serial?: string, packageName?: string): Promise<void> {
  if (!packageName) throw new Error("Usage: clear-data <device> <package-name>");
  await driver.clearAppData(requireDevice(serial), brand<string, "AppPackageName">(packageName));
  printJson({ success: true, operation: "clear-data", deviceId: serial, packageName });
}

async function uninstall(serial?: string, packageName?: string): Promise<void> {
  if (!packageName) throw new Error("Usage: uninstall <device> <package-name>");
  await driver.uninstall(requireDevice(serial), brand<string, "AppPackageName">(packageName));
  printJson({ success: true, operation: "uninstall", deviceId: serial, packageName });
}

async function logs(serial?: string): Promise<void> {
  const deviceId = requireDevice(serial);
  printJson(await driver.collectLogs(deviceId));
}

async function foreground(serial?: string): Promise<void> {
  printJson({ deviceId: serial, packageName: await driver.getForegroundPackage(requireDevice(serial)) });
}

async function permission(serial?: string, packageName?: string, permissionName?: string): Promise<void> {
  if (!packageName || !permissionName) throw new Error("Usage: permission <device> <package-name> <permission>");
  printJson({ deviceId: serial, packageName, permission: permissionName, state: await driver.getPermissionState(requireDevice(serial), brand<string, "AppPackageName">(packageName), permissionName) });
}

async function grantPermission(serial?: string, packageName?: string, permissionName?: string): Promise<void> {
  if (!packageName || !permissionName) throw new Error("Usage: grant-permission <device> <package-name> <permission>");
  const deviceId = requireDevice(serial);
  const pkg = brand<string, "AppPackageName">(packageName);
  const change = await auditedStateChange({ log: new AuditLog(resolve('.appvanta/audit.jsonl')), actor: `appvanta-cli:${process.pid}`, action: 'set-appop', target: `${deviceId}/${packageName}/${permissionName}`, read: () => driver.getPermissionState(deviceId, pkg, permissionName), apply: () => driver.setPermissionState(deviceId, pkg, permissionName, 'allow'), verify: after => { if (after !== 'allow') throw new Error(`AppOps update was not applied: ${after}`); } });
  printJson({ success: true, deviceId: serial, packageName, permission: permissionName, before: change.before, state: change.after });
}

async function diagnose(serial?: string, packageName?: string, since?: string): Promise<void> {
  if (!packageName) throw new Error("Usage: diagnose <device> <package-name>");
  printJson(await driver.diagnoseRuntime(requireDevice(serial), brand<string, "AppPackageName">(packageName), since));
}

async function report(path?: string): Promise<void> {
  if (!path) throw new Error("Usage: report <run-directory-or-report.md>");
  const reportPath = path.endsWith(".md") ? resolve(path) : resolve(path, "report.md");
  console.log(await readFile(reportPath, "utf8"));
}

async function run(serial?: string, packageName?: string): Promise<void> {
  if (!packageName) throw new Error("Usage: run <device> <package-name>");
  const deviceId = requireDevice(serial);
  const devices = await driver.listDevices();
  const device = devices.find(candidate => candidate.id === deviceId);
  if (!device) throw new Error(`Device not found or offline: ${serial}`);
  const context = await createRunContext({ runsDirectory: resolve(".appvanta", "runs"), driver, device });
  await mkdir(resolve(context.rootDirectory, "logs"), { recursive: true });
  await driver.launch(deviceId, brand<string, "AppPackageName">(packageName));
  const observation = await driver.observe(deviceId);
  const logs = await driver.collectLogs(deviceId);
  const metadata = { ...context.metadata, status: "passed" as const, finishedAt: new Date().toISOString() };
  const evidence = [observation.screenshotPath, observation.uiTreePath, logs.path].filter((path): path is string => path !== undefined);
  const step = { index: 1, description: `Launch ${packageName} and capture runtime state`, status: "passed" as const, evidence };
  await context.evidence.appendStep(step);
  const reportPath = await writeMarkdownReport(context.rootDirectory, { metadata, deviceName: device.name, steps: [step] });
  printJson({ status: "passed", runDirectory: context.rootDirectory, report: reportPath, observation, logs });
}

async function runFlow(serial?: string, flowPath?: string): Promise<void> {
  if (!flowPath) throw new Error("Usage: run-flow <device> <flow.json|yaml>");
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Flow interrupted'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await runAndroidFlow(requireDevice(serial), await readFlowFile(flowPath), controller.signal);
    if (result.status !== 'passed') process.exitCode = 1;
    printJson(result);
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  }
}

function requireDevice(serial?: string) {
  if (!serial) throw new Error("A device serial is required");
  return brand<string, "DeviceId">(serial);
}

function printJson(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function printUsage(): void { console.log("AppVanta CLI\n\n  restart-adjudicated-task <predecessor-task-id> <successor-task-id> <receipt.json> <current-lease-token> <checkpoint.json>\n  preview-uncertain-task <task-id>\n  adjudicate-task <task-id> <decision.json>\n  prepare-adjudicated-task <task-id> <expectation.json>\n  reserve-adjudicated-task <task-id> <receipt.json>\n  continue-adjudicated-task <task-id> <receipt.json> [transfer-retry-token]\n  list-avds\n  start-avd <name> [even-port] [timeout-ms] [gpu-mode]\n  continue-task <task-id> <lease-token> <checkpoint.json>\n  inspect-task-progress <task-id>\n  inspect-flow-progress <run-directory>\n  tasks\n  task <task-id>\n  pause-task <task-id>\n  resume-task <task-id>\n  cancel-task <task-id>\n  monitors\n  monitor <monitor-id>\n  release-monitor <monitor-id>\n  batches\n  batch <batch-id>\n  cancel-batch <batch-id>\n  doctor [--fix]\n  list-devices\n  observe <device>\n  install <device> <apk>\n  launch <device> <package-name>\n  run <device> <package-name>\n  run-flow <device> <flow.json|yaml>\n  run-flows <device1,device2,...> <flow.json|yaml> [concurrency]\n  record-interactions <device> <package1,package2> <seconds> [--include-text]\n  visual-diff <baseline.png> <current.png> <diff.png> [channel-threshold] [max-mismatch-ratio] [ignore-regions.json]\n  logs <device>\n  report <run-directory-or-report.md>"); }
