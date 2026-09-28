import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Action, DeviceId, Point } from '@appvanta/core';

const exec = promisify(execFile);
const component = 'dev.appvanta.input/.GestureService';
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
type GestureAction = Extract<Action, { kind: 'pinch' | 'rotate-gesture' | 'multi-touch' }>;
export interface GesturePayload { readonly durationMs: number; readonly strokes: readonly { readonly points: readonly Point[] }[] }

export function gesturePayload(action: GestureAction): GesturePayload {
  if (action.kind === 'multi-touch') return { durationMs: action.durationMs, strokes: action.strokes };
  if (action.kind === 'pinch') {
    const start = action.startSpan / 2, end = action.endSpan / 2;
    return { durationMs: action.durationMs, strokes: [
      { points: [{ x: Math.round(action.center.x - start), y: action.center.y }, { x: Math.round(action.center.x - end), y: action.center.y }] },
      { points: [{ x: Math.round(action.center.x + start), y: action.center.y }, { x: Math.round(action.center.x + end), y: action.center.y }] },
    ] };
  }
  const points = (offset: number) => Array.from({ length: 13 }, (_, index) => {
    const angle = (offset + action.degrees * index / 12) * Math.PI / 180;
    return { x: Math.round(action.center.x + Math.cos(angle) * action.radius), y: Math.round(action.center.y + Math.sin(angle) * action.radius) };
  });
  return { durationMs: action.durationMs, strokes: [{ points: points(0) }, { points: points(180) }] };
}

export async function dispatchGestureWithHelper(adb: string, device: DeviceId, action: GestureAction, signal?: AbortSignal): Promise<void> {
  const run = (args: string[]) => exec(adb, ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: Math.max(20000, action.durationMs + 10000), ...(signal ? { signal } : {}) });
  const installed = await run(['pm', 'path', 'dev.appvanta.input']);
  if (!installed.stdout.trim().split(/\r?\n/).some(line => line.startsWith('package:/'))) throw new Error('Install the AppVanta input helper first; see docs/input.md');
  const enabled = (await run(['settings', 'get', 'secure', 'enabled_accessibility_services'])).stdout.trim();
  if (!enabled.split(':').some(value => value === component || value === 'dev.appvanta.input/dev.appvanta.input.GestureService')) throw new Error('Enable the AppVanta Gesture Service in Android Accessibility settings');
  const payload = Buffer.from(JSON.stringify(gesturePayload(action)), 'utf8').toString('base64');
  const result = await run(['am', 'broadcast', '-a', 'dev.appvanta.input.DISPATCH_GESTURE', '-p', 'dev.appvanta.input', '--es', 'gesture64', quote(payload)]);
  if (!/result=1\b/.test(result.stdout)) throw new Error(`Gesture was not acknowledged: ${result.stdout.trim()}`);
}
