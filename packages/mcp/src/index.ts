#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ParameterError, protocolSession } from './protocol.js';
import { Ajv } from 'ajv';
import { toolSchema } from './schemas.js';
import { adjudicationTools, callAdjudicationTool } from './adjudication-tools.js';
import { recordedFlow } from '@appvanta/core';
import { inspectTaskProgress } from '@appvanta/core';
import { continueAndroidTask } from '@appvanta/android';
import { listAndroidAvds } from '@appvanta/android';
import { startAndroidAvd } from '@appvanta/android';
import { startContinuation } from './start-continuation.js';
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { recoverAndroidFlow, analyzePerfetto, AdbDriver, runAndroidAction, runAndroidFlow, runAndroidFlows, parseUiTree, interactionCandidates, startManualRecording, stopManualRecording } from "@appvanta/android";
import { inspectDeviceLock, brand, parseAction, parseFlow, withDeviceLock, TaskStore, TaskInstructionStore, AuditLog, auditedStateChange, comparePngScreenshots, MonitorStore, BatchStore, validateWebhookUrl, validateWebhookSigningSecret } from "@appvanta/core";
import type { FlowDefinition, TaskRecord, MonitorRecord, BatchRecord } from "@appvanta/core";

if (process.env.APPVANTA_PROJECT_ROOT) {
  if (!isAbsolute(process.env.APPVANTA_PROJECT_ROOT)) throw new Error('APPVANTA_PROJECT_ROOT must be an absolute path');
  process.chdir(process.env.APPVANTA_PROJECT_ROOT);
}
const taskStore = new TaskStore(resolve('.appvanta/tasks'));
const taskInstructions = new TaskInstructionStore(taskStore);
const monitorStore = new MonitorStore(resolve('.appvanta/monitors'));
const batchStore = new BatchStore(resolve('.appvanta/batches'));
const webhookOrigins = (process.env.APPVANTA_WEBHOOK_ALLOW_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
const webhookSigningSecret = process.env.APPVANTA_WEBHOOK_SIGNING_SECRET ? validateWebhookSigningSecret(process.env.APPVANTA_WEBHOOK_SIGNING_SECRET) : undefined;
const rawTools = [
  { name: 'upload_attachment', description: 'Snapshot a local file and upload it to the Android managed provider. Does not share it. Requires installed helper; retains the lease on incomplete upload for explicit recover_upload cleanup.', inputSchema: { type: 'object', additionalProperties: false, properties: { deviceId: { type: 'string', minLength: 1 }, localFile: { type: 'string', minLength: 1 }, mimeType: { type: 'string', minLength: 3, maxLength: 127 }, displayName: { type: 'string', minLength: 1, maxLength: 255 } }, required: ['deviceId', 'localFile', 'mimeType'] } },
  ...['inspect', 'delete'].map(operation => ({ name: `${operation}_upload`, description: operation === 'inspect' ? 'Read managed upload state without acquiring a lease or authorizing upload/share.' : 'Explicitly revoke and delete one managed upload; records a cleanup operation and retains the lease if deletion is unverified.', inputSchema: { type: 'object', additionalProperties: false, properties: { deviceId: { type: 'string', minLength: 1 }, id: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' } }, required: ['deviceId', 'id'] } })),
  { name: 'recover_upload', description: 'Clean a bound interrupted upload/delete operation using its exact retained device lease token. Deletes owned upload bytes and staging files; never resumes upload or sharing. Once begun cleanup is not cancelled.', inputSchema: { type: 'object', additionalProperties: false, properties: { deviceId: { type: 'string', minLength: 1 }, leaseToken: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' } }, required: ['deviceId', 'leaseToken'] } },
  ...adjudicationTools,
  { name: 'start_avd', description: 'Start a configured AVD headlessly or reuse its running instance. Waits for Android boot completion, saves logs, and leaves the process running on timeout. Does not wipe data.', inputSchema: { type: 'object', properties: { name: { type: 'string', pattern: '^[A-Za-z0-9_.-]+$' }, port: { type: 'integer', minimum: 5554, maximum: 5682, multipleOf: 2 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 }, gpu: { type: 'string', enum: ['auto', 'host', 'software', 'lavapipe', 'swiftshader', 'swangle'] } }, required: ['name'] } },
  { name: 'list_avds', description: 'List locally configured Android Virtual Devices using the installed emulator binary. This inventory does not imply devices are booted or ready.', inputSchema: { type: 'object', properties: {} } },
  { name: 'inspect_task_progress', description: 'Inspect interrupted task progress and evidence without executing remaining actions. A consistent boundary alone does not authorize continuation.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', pattern: '^task-[a-f0-9-]{36}$' } }, required: ['taskId'] } },
  { name: 'continue_task', description: 'Synchronously continue an interrupted Android task using its exact abandoned device lease token and an explicit live checkpoint. Creates a linked successor task, never repeats completed steps or app-data resets, and retains the lease on failure. This request remains attached to this MCP process; it is not a detached worker.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', pattern: '^task-[a-f0-9-]{36}$' }, leaseToken: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' }, checkpoint: { type: 'object' } }, required: ['taskId', 'leaseToken', 'checkpoint'] } },
  { name: 'inspect_device_lock', description: 'Read a device lease and owner status without acquiring or releasing it', inputSchema: { type: 'object', properties: { deviceId: { type: 'string' } }, required: ['deviceId'] } },
  { name: 'inspect_attachment_share', description: 'Read and validate a native attachment operation receipt without acquiring a device lease, resending attachments, or authorizing continuation. Dispatched means Android launch returned, not receiver content verification.', inputSchema: { type: 'object', additionalProperties: false, properties: { deviceId: { type: 'string', minLength: 1 }, operation: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' } }, required: ['deviceId', 'operation'] } },
  { name: 'recover_flow', description: 'Restore persisted capture, network, file, IME, runtime-permission and AppOps state of a dead owner using the exact lease token. Retains the lock on conflicts or unverifiable ownership. Does not replay actions or mark the test passed. Once cleanup starts it finishes independently of request cancellation; inspect recovery evidence afterward.', inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, leaseToken: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' } }, required: ['deviceId', 'leaseToken'] } },
  { name: 'analyze_perfetto', description: 'Analyze app CPU scheduling from an existing Perfetto trace; requires installed perfetto Python package', inputSchema: { type: 'object', properties: { trace: { type: 'string' }, packageName: { type: 'string' }, python: { type: 'string' }, scenario: { type: 'string' }, windowMs: { type: 'integer', minimum: 1, maximum: 9007199254740991 } }, required: ['trace', 'packageName'] } },
  { name: 'record_flow', description: 'Return a replayable Flow compiled from acknowledged operations in a completed passing run', inputSchema: { type: 'object', properties: { runDirectory: { type: 'string' } }, required: ['runDirectory'], additionalProperties: false } },
  { name: 'compare_screenshots', description: 'Compare two PNG screenshots, write a visual diff, and enforce pixel mismatch tolerance', inputSchema: { type: 'object', properties: { baselinePath: { type: 'string' }, currentPath: { type: 'string' }, diffPath: { type: 'string' }, channelThreshold: { type: 'integer', minimum: 0, maximum: 255 }, maxMismatchRatio: { type: 'number', minimum: 0, maximum: 1 } }, required: ['baselinePath', 'currentPath', 'diffPath'] } },
  { name: 'start_interaction_recording', description: 'Start an allowlisted manual Accessibility interaction recording on a user-enabled test device', inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, packages: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9_.]+$' } }, includeText: { type: 'boolean' } }, required: ['deviceId', 'packages'] } },
  { name: 'stop_interaction_recording', description: 'Stop a manual interaction recording, preserve raw events, and compile a replayable Flow', inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, recordingId: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' } }, required: ['deviceId', 'recordingId'] } },
  { name: 'list_tasks', description: 'List persisted tasks, including interrupted workers', inputSchema: { type: 'object', properties: {} } },
  { name: 'steer_task', description: 'Queue one schema-validated Flow step for execution at the next step boundary of an asynchronous task', inputSchema: { type: 'object', properties: { taskId: { type: 'string', pattern: '^task-[a-f0-9-]{36}$' }, instruction: { type: 'object' } }, required: ['taskId', 'instruction'] } },
  { name: 'list_task_instructions', description: 'List queued, claimed, applied and failed instructions for a task', inputSchema: { type: 'object', properties: { taskId: { type: 'string', pattern: '^task-[a-f0-9-]{36}$' } }, required: ['taskId'] } },
  { name: 'list_monitors', description: 'List persisted continuous observation monitors', inputSchema: { type: 'object', properties: {} } },
  { name: 'start_monitor', description: 'Start bounded periodic screenshot and UI-tree sampling without holding the device lock between samples', inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, intervalMs: { type: 'integer', minimum: 500, maximum: 60000 }, durationMs: { type: 'integer', minimum: 500, maximum: 3600000 } }, required: ['deviceId', 'intervalMs', 'durationMs'] } },
  { name: 'get_monitor', description: 'Read persisted monitor status and sample count', inputSchema: { type: 'object', properties: { monitorId: { type: 'string', pattern: '^monitor-[a-f0-9-]{36}$' } }, required: ['monitorId'] } },
  { name: 'release_monitor', description: 'Request explicit release of a running monitor and stop in-flight observation', inputSchema: { type: 'object', properties: { monitorId: { type: 'string', pattern: '^monitor-[a-f0-9-]{36}$' } }, required: ['monitorId'] } },
  { name: 'list_batches', description: 'List persisted asynchronous multi-device batches', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_batch', description: 'Read asynchronous multi-device batch status', inputSchema: { type: 'object', properties: { batchId: { type: 'string', pattern: '^batch-task-[a-f0-9-]{36}$' } }, required: ['batchId'] } },
  { name: 'cancel_batch', description: 'Cancel pending and in-flight work in an asynchronous multi-device batch', inputSchema: { type: 'object', properties: { batchId: { type: 'string', pattern: '^batch-task-[a-f0-9-]{36}$' } }, required: ['batchId'] } },
  { name: 'start_flows', description: 'Start a persisted asynchronous Flow batch across unique devices', inputSchema: { type: 'object', properties: { deviceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, uniqueItems: true }, flow: { type: 'object' }, concurrency: { type: 'integer', minimum: 1, maximum: 32 } }, required: ['deviceIds', 'flow'] } },
  { name: 'run_flows', description: 'Run one complete Flow per unique device with bounded concurrency', inputSchema: { type: 'object', properties: { deviceIds: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true }, flow: { type: 'object' }, concurrency: { type: 'integer', minimum: 1, maximum: 32 } }, required: ['deviceIds', 'flow'] } },
  { name: "list_devices", description: "List connected Android devices", inputSchema: { type: "object", properties: {} } },
  { name: "observe_app", description: "Capture a screenshot and UI tree", inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "explore_ui", description: "Observe UI and return actionable nodes", inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "record_screen", description: "Capture a short Android screen recording", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, durationSeconds: { type: "number" } }, required: ["deviceId"] } },
  { name: "collect_network", description: "Collect Android network statistics", inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "collect_performance", description: "Collect Android raw CPU and versioned memory snapshot evidence", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, packageName: { type: "string" }, scenario: { type: "string", minLength: 1 } }, required: ["deviceId", "packageName"] } },
  { name: "collect_perfetto", description: "Collect an Android Perfetto trace", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, durationSeconds: { type: "number" } }, required: ["deviceId"] } },
  { name: "set_http_proxy", description: "Set or clear the Android HTTP proxy", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, proxy: { type: ["string", "null"] } }, required: ["deviceId"] } },
  { name: "execute_action", description: "Execute a structured Android action", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, action: { type: "object" } }, required: ["deviceId", "action"] } },
  { name: "collect_logs", description: "Collect Android Logcat", inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "install_app", description: "Install an APK on an Android device", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, apkPath: { type: "string" } }, required: ["deviceId", "apkPath"] } },
  { name: "start_app", description: "Launch an Android application", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, packageName: { type: "string" } }, required: ["deviceId", "packageName"] } },
  { name: "stop_app", description: "Stop an Android application", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, packageName: { type: "string" } }, required: ["deviceId", "packageName"] } },
  { name: "clear_app_data", description: "Clear Android application data", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, packageName: { type: "string" } }, required: ["deviceId", "packageName"] } },
  { name: "uninstall_app", description: "Uninstall an Android application", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, packageName: { type: "string" } }, required: ["deviceId", "packageName"] } },
  { name: "foreground_app", description: "Get the foreground package", inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "diagnose_runtime", description: "Collect retained crash/ANR events for an app since device epoch seconds (default last 5 minutes)", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, packageName: { type: "string" }, since: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?$" } }, required: ["deviceId", "packageName"] } },
  { name: "run_flow", description: "Run a sequence of validated Android actions", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, flow: { type: "object" }, steps: { type: "array" } }, required: ["deviceId"], anyOf: [{ required: ["flow"] }, { required: ["steps"] }] } },
  { name: "generate_report", description: "Return a report path for an existing run", inputSchema: { type: "object", properties: { runDirectory: { type: "string" } }, required: ["runDirectory"] } },
  { name: "start_flow", description: "Start an asynchronous Android flow with an optional allowlisted completion webhook", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, flow: { type: "object" }, steps: { type: "array" }, completionWebhook: { type: 'string', format: 'http-url' } }, required: ["deviceId"], anyOf: [{ required: ["flow"] }, { required: ["steps"] }] } },
  { name: "get_task", description: "Get asynchronous task status", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
  { name: "pause_task", description: "Request an asynchronous task to pause at its next step boundary", inputSchema: { type: "object", properties: { taskId: { type: "string", pattern: '^task-[a-f0-9-]{36}$' } }, required: ["taskId"] } },
  { name: "resume_task", description: "Release a persisted pause request for an asynchronous task", inputSchema: { type: "object", properties: { taskId: { type: "string", pattern: '^task-[a-f0-9-]{36}$' } }, required: ["taskId"] } },
  { name: "cancel_task", description: "Cancel a queued or running flow task", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
  { name: "set_permission", description: "Set an Android AppOps permission explicitly", inputSchema: { type: "object", properties: { deviceId: { type: "string" }, packageName: { type: "string" }, permission: { type: "string" }, state: { type: "string", enum: ["allow", "deny"] } }, required: ["deviceId", "packageName", "permission", "state"] } },
];

rawTools.push({ ...rawTools.find(tool => tool.name === 'continue_task')!, name: 'start_task_continuation', description: 'Continue an interrupted task in an independent local worker. Returns a successor task ID after verified worker readiness. Recovery continues if this MCP process exits. Use get_task and cancel_task for the successor; inspect the persisted continuation request on startup timeout.' });
const tools = rawTools.map(tool => ({ ...tool, inputSchema: toolSchema(tool.name, tool.inputSchema) }));
const ajv = new Ajv({ strict: false, allErrors: false, coerceTypes: false });
ajv.addFormat('http-url', { type: 'string', validate: (value: string) => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } } });
const validators = new Map(tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
const handleProtocolLine = protocolSession(tools, callTool);

const input = createInterface({ input: process.stdin });
input.once('close', () => handleProtocolLine.close());
input.on("line", (line) => {
  void handleLine(line).catch(error => process.stderr.write(`Protocol output failed: ${String(error)}\n`));
});

async function handleLine(line: string): Promise<void> {
  const response = await handleProtocolLine(line);
  if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function callTool(name: string | undefined, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const validate = name ? validators.get(name) : undefined;
  if (!validate) throw new ParameterError(`Unknown tool: ${String(name)}`);
  if (!validate(args)) throw new ParameterError(ajv.errorsText(validate.errors));
  try {
    if (name === 'execute_action') parseAction(args.action);
    if (name === 'run_flow' || name === 'start_flow') flowArguments(args);
    if (name === 'start_flow' && typeof args.completionWebhook === 'string') validateWebhookUrl(args.completionWebhook, webhookOrigins);
    if (name === 'run_flows' || name === 'start_flows') parseFlow(args.flow);
    if (name === 'steer_task') instructionArgument(args);
    if (name === 'start_monitor' && typeof args.intervalMs === 'number' && typeof args.durationMs === 'number' && args.durationMs < args.intervalMs) throw new Error('durationMs must be at least intervalMs');
  } catch (error) { throw new ParameterError(String(error)); }
  if (name === 'execute_action' && typeof args.deviceId === 'string' && parseAction(args.action).kind === 'shake') {
    return runAndroidAction(args.deviceId, args.action, signal);
  }
  if (typeof args.deviceId === 'string' && !['run_flow', 'start_flow', 'start_monitor', 'inspect_device_lock', 'inspect_attachment_share', 'recover_flow', 'upload_attachment', 'inspect_upload', 'delete_upload', 'recover_upload'].includes(name ?? '')) {
    return withDeviceLock(args.deviceId, () => callUnlockedTool(name, args, signal));
  }
  return callUnlockedTool(name, args, signal);
}
async function callUnlockedTool(name: string | undefined, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const driver = new AdbDriver({ artifactsDirectory: resolve(".appvanta", "mcp-artifacts", randomUUID()), signal });
  const deviceId = typeof args.deviceId === "string" ? brand<string, "DeviceId">(args.deviceId) : undefined;
  switch (name) {
    case 'upload_attachment': return driver.uploadAttachment(brand(String(args.deviceId)), String(args.localFile), String(args.mimeType), typeof args.displayName === 'string' ? args.displayName : undefined);
    case 'inspect_upload': return driver.inspectUpload(brand(String(args.deviceId)), String(args.id));
    case 'delete_upload': return driver.deleteUpload(brand(String(args.deviceId)), String(args.id));
    case 'recover_upload': return driver.recoverUpload(brand(String(args.deviceId)), String(args.leaseToken));
    case 'preview_uncertain_task':
    case 'adjudicate_task':
    case 'prepare_adjudicated_task':
    case 'reserve_adjudicated_task':
    case 'restart_adjudicated_task':
    case 'continue_adjudicated_task': return callAdjudicationTool(name, taskStore, args, signal);
    case 'list_avds': return listAndroidAvds();
    case 'start_avd': return startAndroidAvd(String(args.name), typeof args.port === 'number' ? args.port : 5554, typeof args.timeoutMs === 'number' ? args.timeoutMs : 120000, args.gpu as string | undefined, signal);
    case 'inspect_task_progress': return inspectTaskProgress(taskStore, String(args.taskId));
    case 'continue_task': return continueAndroidTask(taskStore, String(args.taskId), String(args.leaseToken), args.checkpoint, signal);
    case 'start_task_continuation': return startContinuation(taskStore, String(args.taskId), String(args.leaseToken), args.checkpoint, signal);
    case 'inspect_device_lock': return inspectDeviceLock(String(args.deviceId));
    case 'inspect_attachment_share': return driver.inspectAttachmentShare(brand(String(args.deviceId)), String(args.operation));
    case 'recover_flow': return recoverAndroidFlow(String(args.deviceId), String(args.leaseToken));
    case 'analyze_perfetto': return analyzePerfetto({ trace: String(args.trace), packageName: String(args.packageName), signal, ...(typeof args.python === 'string' ? { python: args.python } : {}), ...(typeof args.scenario === 'string' ? { scenario: args.scenario } : {}), ...(typeof args.windowMs === 'number' ? { windowMs: args.windowMs } : {}) });
    case 'compare_screenshots': return comparePngScreenshots(resolve(String(args.baselinePath)), resolve(String(args.currentPath)), resolve(String(args.diffPath)), { ...(typeof args.channelThreshold === 'number' ? { channelThreshold: args.channelThreshold } : {}), ...(typeof args.maxMismatchRatio === 'number' ? { maxMismatchRatio: args.maxMismatchRatio } : {}), ...(typeof args.maxAlignmentShift === 'number' ? { maxAlignmentShift: args.maxAlignmentShift } : {}), ...(typeof args.minSsim === 'number' ? { minSsim: args.minSsim } : {}), ...(Array.isArray(args.ignoreRegions) ? { ignoreRegions: args.ignoreRegions as import('@appvanta/core').VisualIgnoreRegion[] } : {}) });
    case 'start_interaction_recording': {
      if (!deviceId || !Array.isArray(args.packages) || args.packages.some(value => typeof value !== 'string')) throw new Error('deviceId and packages are required');
      return startManualRecording(process.env.ADB_PATH ?? 'adb', deviceId, args.packages as string[], args.includeText === true, resolve('.appvanta/manual-recordings'), signal);
    }
    case 'stop_interaction_recording': {
      if (!deviceId || typeof args.recordingId !== 'string') throw new Error('deviceId and recordingId are required');
      return stopManualRecording(process.env.ADB_PATH ?? 'adb', deviceId, args.recordingId, resolve('.appvanta/manual-recordings'));
    }
    case "list_tasks": return taskStore.list();
    case 'steer_task': {
      if (typeof args.taskId !== 'string') throw new Error('taskId is required');
      return taskInstructions.enqueue(args.taskId, instructionArgument(args));
    }
    case 'list_task_instructions': {
      if (typeof args.taskId !== 'string') throw new Error('taskId is required');
      return taskInstructions.list(args.taskId);
    }
    case 'list_monitors': return monitorStore.list();
    case 'start_monitor': {
      if (!deviceId || typeof args.intervalMs !== 'number' || typeof args.durationMs !== 'number') throw new Error('deviceId, intervalMs and durationMs are required');
      const monitor = await monitorStore.create(deviceId, args.intervalMs, args.durationMs);
      const started = await launchMonitorWorker(monitor);
      return { monitorId: monitor.id, status: started.status, workerPid: started.owner.pid };
    }
    case 'get_monitor': if (typeof args.monitorId !== 'string') throw new Error('monitorId is required'); return monitorStore.get(args.monitorId);
    case 'release_monitor': {
      if (typeof args.monitorId !== 'string') throw new Error('monitorId is required');
      return monitorStore.requestRelease(args.monitorId);
    }
    case 'list_batches': return batchStore.list();
    case 'get_batch': if (typeof args.batchId !== 'string') throw new Error('batchId is required'); return batchStore.get(args.batchId);
    case 'cancel_batch': {
      if (typeof args.batchId !== 'string') throw new Error('batchId is required');
      return batchStore.requestCancel(args.batchId);
    }
    case 'start_flows': {
      if (!Array.isArray(args.deviceIds) || args.deviceIds.some(id => typeof id !== 'string')) throw new Error('deviceIds must be strings');
      const flow = parseFlow(args.flow), concurrency = typeof args.concurrency === 'number' ? args.concurrency : 2;
      if (flow.network && concurrency !== 1) throw new Error('Network-enabled batches require concurrency 1');
      const batch = await batchStore.create(args.deviceIds as string[], flow, concurrency);
      const started = await launchBatchWorker(batch);
      return { batchId: batch.id, status: started.status, workerPid: started.owner.pid };
    }
    case 'run_flows': {
      if (!Array.isArray(args.deviceIds) || args.deviceIds.some(id => typeof id !== 'string')) throw new Error('deviceIds must be strings');
      if (args.concurrency !== undefined && typeof args.concurrency !== 'number') throw new Error('Invalid concurrency');
      return runAndroidFlows(args.deviceIds as string[], args.flow, args.concurrency as number | undefined, signal);
    }
    case "list_devices": return driver.listDevices();
    case "observe_app": if (!deviceId) throw new Error("deviceId is required"); return driver.observe(deviceId);
    case "explore_ui": {
      if (!deviceId) throw new Error("deviceId is required");
      const observation = await driver.observe(deviceId);
      const xml = observation.uiTreePath ? await (await import("node:fs/promises")).readFile(observation.uiTreePath, "utf8") : "";
      const tree = parseUiTree(xml);
      return { observation, tree, candidates: interactionCandidates(tree).slice(0, 100) };
    }
    case "record_screen": if (!deviceId) throw new Error("deviceId is required"); return driver.recordScreen(deviceId, typeof args.durationSeconds === "number" ? args.durationSeconds : 5);
    case "collect_network": if (!deviceId) throw new Error("deviceId is required"); return driver.collectNetwork(deviceId);
    case "collect_performance": if (!deviceId || typeof args.packageName !== "string") throw new Error("deviceId and packageName are required"); return driver.collectPerformance(deviceId, brand<string, "AppPackageName">(args.packageName), typeof args.scenario === "string" ? args.scenario : undefined);
    case "collect_perfetto": if (!deviceId) throw new Error("deviceId is required"); return driver.collectPerfetto(deviceId, typeof args.durationSeconds === "number" ? args.durationSeconds : 5);
    case "set_http_proxy": if (!deviceId || (args.proxy !== null && typeof args.proxy !== "string" && args.proxy !== undefined)) throw new Error("deviceId and optional proxy are required"); await driver.setHttpProxy(deviceId, typeof args.proxy === "string" ? args.proxy : null); return { success: true, deviceId, proxy: args.proxy ?? null };
    case "collect_logs": if (!deviceId) throw new Error("deviceId is required"); return driver.collectLogs(deviceId);
    case "install_app": if (!deviceId || typeof args.apkPath !== "string") throw new Error("deviceId and apkPath are required"); await driver.install(deviceId, { path: args.apkPath, format: "apk" }); return { success: true, deviceId, apkPath: args.apkPath };
    case "start_app": if (!deviceId || typeof args.packageName !== "string") throw new Error("deviceId and packageName are required"); await driver.launch(deviceId, brand<string, "AppPackageName">(args.packageName)); return { success: true, deviceId, packageName: args.packageName };
    case "stop_app": if (!deviceId || typeof args.packageName !== "string") throw new Error("deviceId and packageName are required"); await driver.stopApp(deviceId, brand<string, "AppPackageName">(args.packageName)); return { success: true, deviceId, packageName: args.packageName };
    case "clear_app_data": if (!deviceId || typeof args.packageName !== "string") throw new Error("deviceId and packageName are required"); await driver.clearAppData(deviceId, brand<string, "AppPackageName">(args.packageName)); return { success: true, deviceId, packageName: args.packageName };
    case "uninstall_app": if (!deviceId || typeof args.packageName !== "string") throw new Error("deviceId and packageName are required"); await driver.uninstall(deviceId, brand<string, "AppPackageName">(args.packageName)); return { success: true, deviceId, packageName: args.packageName };
    case "foreground_app": if (!deviceId) throw new Error("deviceId is required"); return { deviceId, packageName: await driver.getForegroundPackage(deviceId) };
    case "diagnose_runtime": if (!deviceId || typeof args.packageName !== "string") throw new Error("deviceId and packageName are required"); return driver.diagnoseRuntime(deviceId, brand<string, "AppPackageName">(args.packageName), typeof args.since === "string" ? args.since : undefined);
    case 'record_flow': return recordedFlow(resolve(String(args.runDirectory)));
    case "run_flow": {
      if (!deviceId) throw new Error('deviceId is required');
      return runAndroidFlow(deviceId, flowArguments(args), signal);
    }
    case "generate_report": if (typeof args.runDirectory !== "string") throw new Error("runDirectory is required"); return { reportPath: `${args.runDirectory.replace(/[\\/]$/, "")}/report.md` };
    case "start_flow": {
      if (!deviceId) throw new Error('deviceId is required');
      const flow = flowArguments(args);
      const task = await taskStore.create(deviceId, flow, { ...(typeof args.completionWebhook === 'string' ? { completionWebhook: args.completionWebhook } : {}) });
      const started = await launchTaskWorker(task);
      return { taskId: task.id, status: started.status, workerPid: started.owner.pid };
    }
    case "get_task": {
      if (typeof args.taskId !== 'string') throw new Error('taskId is required');
      return taskStore.get(args.taskId);
    }
    case 'pause_task': if (typeof args.taskId !== 'string') throw new Error('taskId is required'); return taskStore.requestPause(args.taskId);
    case 'resume_task': if (typeof args.taskId !== 'string') throw new Error('taskId is required'); return taskStore.requestResume(args.taskId);
    case "cancel_task": {
      if (typeof args.taskId !== 'string') throw new Error('taskId is required');
      return taskStore.requestCancel(args.taskId);
    }
    case "set_permission": {
      if (!deviceId || typeof args.packageName !== "string" || typeof args.permission !== "string" || (args.state !== "allow" && args.state !== "deny")) throw new Error("deviceId, packageName, permission and state are required");
      const packageName = brand<string, "AppPackageName">(args.packageName);
      const permission = args.permission, state = args.state;
      const change = await auditedStateChange({ log: new AuditLog(resolve('.appvanta/audit.jsonl')), actor: `appvanta-mcp:${process.pid}`, action: 'set-appop', target: `${deviceId}/${args.packageName}/${permission}`, read: () => driver.getPermissionState(deviceId, packageName, permission), apply: () => driver.setPermissionState(deviceId, packageName, permission, state), verify: after => { if (after !== state) throw new Error(`AppOps update was not applied: ${after}`); } });
      return { deviceId, packageName: args.packageName, permission: args.permission, before: change.before, state: change.after };
    }
    case "execute_action": if (!deviceId || !args.action || typeof args.action !== "object") throw new Error("deviceId and action are required"); return driver.execute(deviceId, parseAction(args.action));
    default: throw new Error(`Unknown tool: ${String(name)}`);
  }
}

async function launchMonitorWorker(monitor: MonitorRecord): Promise<MonitorRecord> {
  const workerSession = randomUUID(), workerPath = fileURLToPath(new URL('./monitor-worker.js', import.meta.url));
  const child = spawn(process.execPath, [workerPath, monitor.id, workerSession], { cwd: process.cwd(), windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env, APPVANTA_PROJECT_ROOT: process.cwd() } });
  const workerPid = child.pid;
  if (!workerPid) throw new Error(`Monitor ${monitor.id} worker did not receive a PID`);
  let transferred = false;
  try {
    await monitorStore.transferQueued(monitor, workerPid, workerSession); transferred = true;
    const deadline = Date.now() + 10000, readyPath = resolve(monitorStore.directory, monitor.id, 'worker.ready.json');
    while (Date.now() < deadline) {
      try {
        const ready = JSON.parse(await readFile(readyPath, 'utf8')) as { monitorId?: unknown; pid?: unknown; session?: unknown };
        if (ready.monitorId !== monitor.id || ready.pid !== workerPid || ready.session !== workerSession) throw new Error('Monitor worker readiness evidence does not match ownership');
        return await monitorStore.get(monitor.id);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      if (child.exitCode !== null) {
        let detail = `exit ${child.exitCode}`; try { detail = await readFile(resolve(monitorStore.directory, monitor.id, 'worker-error.txt'), 'utf8'); } catch {}
        throw new Error(`Monitor worker exited before readiness: ${detail}`);
      }
      await delay(25);
    }
    throw new Error('Monitor worker readiness deadline exceeded');
  } catch (error) {
    if (child.exitCode === null) child.kill();
    const message = `Monitor ${monitor.id} worker startup failed: ${String(error)}`;
    if (transferred) await monitorStore.failTransferredStartup(monitor.id, workerPid, workerSession, message).catch(() => {});
    else { monitor.status = 'failed'; monitor.finishedAt = new Date().toISOString(); monitor.error = message; await monitorStore.save(monitor).catch(() => {}); }
    throw new Error(message);
  } finally { child.unref(); }
}

function flowArguments(args: Record<string, unknown>): FlowDefinition {
  if (args.flow !== undefined) return parseFlow(args.flow);
  if (!Array.isArray(args.steps)) throw new Error('flow or steps is required');
  return parseFlow({ version: 1, name: 'MCP Flow', steps: args.steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Invalid step');
    return { description: `Step ${index + 1}`, ...step };
  }) });
}

function instructionArgument(args: Record<string, unknown>) {
  return parseFlow({ version: 1, name: 'Task instruction', steps: [args.instruction] }).steps[0]!;
}

async function launchTaskWorker(task: TaskRecord): Promise<TaskRecord> {
  const workerSession = randomUUID(), workerPath = fileURLToPath(new URL('./task-worker.js', import.meta.url));
  const child = spawn(process.execPath, [workerPath, task.id, workerSession], { cwd: process.cwd(), windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env, APPVANTA_PROJECT_ROOT: process.cwd() } });
  const workerPid = child.pid;
  if (!workerPid) throw new Error(`Task ${task.id} worker did not receive a PID`);
  let transferred = false;
  try {
    await taskStore.transferQueued(task, workerPid, workerSession); transferred = true;
    const deadline = Date.now() + 10000, readyPath = resolve(taskStore.directory, task.id, 'worker.ready.json');
    while (Date.now() < deadline) {
      try {
        const ready = JSON.parse(await readFile(readyPath, 'utf8')) as { taskId?: unknown; pid?: unknown; session?: unknown };
        if (ready.taskId !== task.id || ready.pid !== workerPid || ready.session !== workerSession) throw new Error('Task worker readiness evidence does not match ownership');
        return await taskStore.get(task.id);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      if (child.exitCode !== null) {
        let detail = `exit ${child.exitCode}`; try { detail = await readFile(resolve(taskStore.directory, task.id, 'worker-error.txt'), 'utf8'); } catch {}
        throw new Error(`Task worker exited before readiness: ${detail}`);
      }
      await delay(25);
    }
    throw new Error('Task worker readiness deadline exceeded');
  } catch (error) {
    if (child.exitCode === null) child.kill();
    const message = `Task ${task.id} worker startup failed: ${String(error)}`;
    if (transferred) await taskStore.failTransferredStartup(task.id, workerPid, workerSession, message).catch(() => {});
    else { task.status = 'failed'; task.finishedAt = new Date().toISOString(); task.error = message; await taskStore.save(task).catch(() => {}); }
    throw new Error(message);
  } finally { child.unref(); }
}

async function launchBatchWorker(batch: BatchRecord): Promise<BatchRecord> {
  const workerSession = randomUUID(), workerPath = fileURLToPath(new URL('./batch-worker.js', import.meta.url));
  const child = spawn(process.execPath, [workerPath, batch.id, workerSession], { cwd: process.cwd(), windowsHide: true, detached: true, stdio: 'ignore', env: { ...process.env, APPVANTA_PROJECT_ROOT: process.cwd() } });
  const workerPid = child.pid;
  if (!workerPid) throw new Error(`Batch ${batch.id} worker did not receive a PID`);
  let transferred = false;
  try {
    await batchStore.transferQueued(batch, workerPid, workerSession); transferred = true;
    const deadline = Date.now() + 10000, readyPath = resolve(batchStore.directory, batch.id, 'worker.ready.json');
    while (Date.now() < deadline) {
      try {
        const ready = JSON.parse(await readFile(readyPath, 'utf8')) as { batchId?: unknown; pid?: unknown; session?: unknown };
        if (ready.batchId !== batch.id || ready.pid !== workerPid || ready.session !== workerSession) throw new Error('Batch worker readiness evidence does not match ownership');
        return await batchStore.get(batch.id);
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      if (child.exitCode !== null) {
        let detail = `exit ${child.exitCode}`; try { detail = await readFile(resolve(batchStore.directory, batch.id, 'worker-error.txt'), 'utf8'); } catch {}
        throw new Error(`Batch worker exited before readiness: ${detail}`);
      }
      await delay(25);
    }
    throw new Error('Batch worker readiness deadline exceeded');
  } catch (error) {
    if (child.exitCode === null) child.kill();
    const message = `Batch ${batch.id} worker startup failed: ${String(error)}`;
    if (transferred) await batchStore.failTransferredStartup(batch.id, workerPid, workerSession, message).catch(() => {});
    else { batch.status = 'failed'; batch.finishedAt = new Date().toISOString(); batch.error = message; await batchStore.save(batch).catch(() => {}); }
    throw new Error(message);
  } finally { child.unref(); }
}
