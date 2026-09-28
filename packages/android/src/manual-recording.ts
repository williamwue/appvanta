import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseFlow, type DeviceId, type FlowDefinition, type FlowStep, type Target } from '@appvanta/core';

const exec = promisify(execFile);
const component = 'dev.appvanta.input/.GestureService';
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const packagePattern = /^[A-Za-z0-9_.]+$/;
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export interface ManualRecordingSession {
  readonly version: 1;
  readonly recordingId: string;
  readonly deviceId: string;
  readonly packages: readonly string[];
  readonly includeText: boolean;
  readonly startedAt: string;
  readonly rootDirectory: string;
  status: 'starting' | 'recording' | 'stopped' | 'failed';
  finishedAt?: string;
  eventCount?: number;
  ignoredCount?: number;
  eventsSha256?: string;
  flowPath?: string;
  error?: string;
}

interface ManualTarget { readonly resourceId?: string; readonly contentDescription?: string; readonly text?: string; readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
interface ManualEvent { readonly version: 1; readonly sequence: number; readonly timestamp: number; readonly kind: 'click' | 'long-click' | 'scroll' | 'text-change'; readonly packageName: string; readonly target?: ManualTarget; readonly beforeText?: string; readonly afterText?: string; readonly scrollDeltaX?: number; readonly scrollDeltaY?: number }

async function saveSession(session: ManualRecordingSession): Promise<void> {
  const temporary = join(session.rootDirectory, `session-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(session, null, 2), { flag: 'wx' });
  await rename(temporary, join(session.rootDirectory, 'session.json'));
}

function semanticTarget(event: ManualEvent, allowText = true): Target {
  const target = event.target;
  if (!target) throw new Error(`Manual event ${event.sequence} has no target`);
  if (target.resourceId) return { kind: 'resource-id', value: target.resourceId };
  if (target.contentDescription) return { kind: 'accessibility-label', value: target.contentDescription };
  if (allowText && target.text) return { kind: 'text', value: target.text };
  if (![target.left, target.top, target.right, target.bottom].every(Number.isInteger) || target.right <= target.left || target.bottom <= target.top) throw new Error(`Manual event ${event.sequence} has no stable target or bounds`);
  return { kind: 'coordinate', x: Math.floor((target.left + target.right) / 2), y: Math.floor((target.top + target.bottom) / 2) };
}

function parseEvent(value: unknown, expectedSequence: number): ManualEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid manual event ${expectedSequence}`);
  const event = value as Record<string, unknown>;
  if (event.version !== 1 || event.sequence !== expectedSequence || !Number.isFinite(event.timestamp) || !['click', 'long-click', 'scroll', 'text-change'].includes(String(event.kind)) || typeof event.packageName !== 'string' || !packagePattern.test(event.packageName)) throw new Error(`Invalid manual event ${expectedSequence}`);
  if (event.target !== undefined) {
    if (!event.target || typeof event.target !== 'object' || Array.isArray(event.target)) throw new Error(`Invalid manual target ${expectedSequence}`);
    const target = event.target as Record<string, unknown>;
    if (![target.left, target.top, target.right, target.bottom].every(Number.isInteger)) throw new Error(`Invalid manual bounds ${expectedSequence}`);
    for (const name of ['resourceId', 'contentDescription', 'text']) if (target[name] !== undefined && typeof target[name] !== 'string') throw new Error(`Invalid manual target ${expectedSequence}`);
  }
  if (event.kind === 'text-change' && (typeof event.beforeText !== 'string' || typeof event.afterText !== 'string')) throw new Error(`Invalid manual text event ${expectedSequence}`);
  for (const name of ['scrollDeltaX', 'scrollDeltaY']) if (event[name] !== undefined && !Number.isInteger(event[name])) throw new Error(`Invalid manual scroll event ${expectedSequence}`);
  return event as unknown as ManualEvent;
}

export function compileManualRecording(jsonl: string, name = 'Manual interaction recording'): { readonly flow: FlowDefinition; readonly eventCount: number; readonly ignoredCount: number } {
  const lines = jsonl.split(/\r?\n/).filter(Boolean), events = lines.map((line, index) => {
    try { return parseEvent(JSON.parse(line), index + 1); }
    catch (error) { if (error instanceof SyntaxError) throw new Error(`Invalid JSON in manual event ${index + 1}`); throw error; }
  });
  const steps: FlowStep[] = []; let ignoredCount = 0;
  for (const event of events) {
    if (event.kind === 'click') steps.push({ description: `Manual click in ${event.packageName}`, action: { kind: 'tap', target: semanticTarget(event) } });
    else if (event.kind === 'long-click') steps.push({ description: `Manual long click in ${event.packageName}`, action: { kind: 'long-press', target: semanticTarget(event), durationMs: 800 } });
    else if (event.kind === 'text-change') {
      if (!event.afterText!.startsWith(event.beforeText!)) throw new Error(`Manual text edit ${event.sequence} is not an append and cannot be replayed safely`);
      const text = event.afterText!.slice(event.beforeText!.length); if (!text) { ignoredCount++; continue; }
      const target = semanticTarget(event, false), previous = steps.at(-1);
      if (previous?.action?.kind === 'input' && JSON.stringify(previous.action.target) === JSON.stringify(target)) steps[steps.length - 1] = { ...previous, action: { ...previous.action, text: previous.action.text + text } };
      else steps.push({ description: `Manual text input in ${event.packageName}`, action: { kind: 'input', target, text } });
    } else {
      const target = event.target;
      if (!target || target.right <= target.left || target.bottom <= target.top) throw new Error(`Manual scroll ${event.sequence} has invalid bounds`);
      const dx = event.scrollDeltaX ?? 0, dy = event.scrollDeltaY ?? 0;
      if (!dx && !dy) { ignoredCount++; continue; }
      const insetX = Math.min(20, Math.floor((target.right - target.left) / 4)), insetY = Math.min(20, Math.floor((target.bottom - target.top) / 4));
      const centerX = Math.floor((target.left + target.right) / 2), centerY = Math.floor((target.top + target.bottom) / 2);
      const vertical = Math.abs(dy) >= Math.abs(dx);
      const from = vertical ? { x: centerX, y: dy > 0 ? target.bottom - insetY : target.top + insetY } : { x: dx > 0 ? target.right - insetX : target.left + insetX, y: centerY };
      const to = vertical ? { x: centerX, y: dy > 0 ? target.top + insetY : target.bottom - insetY } : { x: dx > 0 ? target.left + insetX : target.right - insetX, y: centerY };
      steps.push({ description: `Manual scroll in ${event.packageName}`, action: { kind: 'swipe', from, to, durationMs: 500 } });
    }
  }
  if (!steps.length) throw new Error('Manual recording contains no replayable interactions');
  const applications = [...new Set(events.map(event => event.packageName))];
  return { flow: parseFlow({ version: 1, name, description: 'Captured external Accessibility interactions. Add explicit checkpoints before relying on this replay.', applications, steps }), eventCount: events.length, ignoredCount };
}

async function helperReady(adb: string, deviceId: DeviceId, signal?: AbortSignal): Promise<void> {
  const run = (args: string[]) => exec(adb, ['-s', deviceId, 'shell', ...args], { encoding: 'utf8', timeout: 20000, ...(signal ? { signal } : {}) });
  const installed = await run(['pm', 'path', 'dev.appvanta.input']);
  if (!installed.stdout.trim().split(/\r?\n/).some(line => line.startsWith('package:/'))) throw new Error('Install the AppVanta input helper first; see docs/input.md');
  const enabled = (await run(['settings', 'get', 'secure', 'enabled_accessibility_services'])).stdout.trim();
  if (!enabled.split(':').some(value => value === component || value === 'dev.appvanta.input/dev.appvanta.input.GestureService')) throw new Error('Enable the AppVanta Gesture Service in Android Accessibility settings');
}

export async function startManualRecording(adb: string, deviceId: DeviceId, packages: readonly string[], includeText: boolean, directory: string, signal?: AbortSignal): Promise<ManualRecordingSession> {
  if (!Array.isArray(packages) || packages.length < 1 || packages.length > 10 || packages.some(value => typeof value !== 'string' || !packagePattern.test(value)) || new Set(packages).size !== packages.length) throw new Error('Manual recording requires 1 to 10 unique package names');
  if (typeof includeText !== 'boolean') throw new Error('includeText must be boolean');
  await helperReady(adb, deviceId, signal);
  const recordingId = randomUUID(), rootDirectory = join(directory, recordingId);
  await mkdir(directory, { recursive: true });
  await mkdir(rootDirectory, { recursive: false });
  const session: ManualRecordingSession = { version: 1, recordingId, deviceId, packages, includeText, startedAt: new Date().toISOString(), rootDirectory, status: 'starting' };
  await saveSession(session);
  const config = Buffer.from(JSON.stringify({ recordingId, packages, includeText }), 'utf8').toString('base64');
  try {
    const result = await exec(adb, ['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'dev.appvanta.input.START_RECORDING', '-p', 'dev.appvanta.input', '--es', 'config64', quote(config)], { encoding: 'utf8', timeout: 20000, ...(signal ? { signal } : {}) });
    if (!/result=1\b/.test(result.stdout)) throw new Error(`Recording was not acknowledged: ${result.stdout.trim()}`);
    session.status = 'recording'; await saveSession(session); return session;
  } catch (error) { session.status = 'failed'; session.error = String(error); session.finishedAt = new Date().toISOString(); await saveSession(session); throw error; }
}

export async function stopManualRecording(adb: string, deviceId: DeviceId, recordingId: string, directory: string, signal?: AbortSignal) {
  if (!idPattern.test(recordingId)) throw new Error('Invalid recording id');
  const rootDirectory = join(directory, recordingId), session = JSON.parse(await readFile(join(rootDirectory, 'session.json'), 'utf8')) as ManualRecordingSession;
  if (session.version !== 1 || session.recordingId !== recordingId || session.deviceId !== deviceId || session.rootDirectory !== rootDirectory || session.status !== 'recording') throw new Error('Manual recording session is not active for this device');
  const remote = `/sdcard/Android/data/dev.appvanta.input/files/recordings/manual-${recordingId}.jsonl`, eventsPath = join(rootDirectory, 'events.jsonl');
  try {
    const stopped = await exec(adb, ['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'dev.appvanta.input.STOP_RECORDING', '-p', 'dev.appvanta.input', '--es', 'recordingId', quote(recordingId)], { encoding: 'utf8', timeout: 20000, ...(signal ? { signal } : {}) });
    if (!/result=1\b/.test(stopped.stdout)) throw new Error(`Recording stop was not acknowledged: ${stopped.stdout.trim()}`);
    await exec(adb, ['-s', deviceId, 'pull', remote, eventsPath], { encoding: 'utf8', timeout: 20000, ...(signal ? { signal } : {}) });
    await exec(adb, ['-s', deviceId, 'shell', 'rm', '-f', remote], { encoding: 'utf8', timeout: 20000 });
    const jsonl = await readFile(eventsPath, 'utf8'), compiled = compileManualRecording(jsonl, `Manual recording ${recordingId}`);
    if (compiled.flow.applications?.some(packageName => !session.packages.includes(packageName))) throw new Error('Manual recording contains an event outside the session package allowlist');
    const flowPath = join(rootDirectory, 'flow.json'); await writeFile(flowPath, `${JSON.stringify(compiled.flow, null, 2)}\n`, { flag: 'wx' });
    session.status = 'stopped'; session.finishedAt = new Date().toISOString(); session.eventCount = compiled.eventCount; session.ignoredCount = compiled.ignoredCount; session.eventsSha256 = createHash('sha256').update(jsonl).digest('hex'); session.flowPath = flowPath;
    await saveSession(session); return { ...session, flow: compiled.flow, eventsPath };
  } catch (error) { session.status = 'failed'; session.error = String(error); session.finishedAt = new Date().toISOString(); await saveSession(session); throw error; }
}
