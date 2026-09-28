import { parseNativeStacks } from './native-stacks.js';
import type { NativeStack } from './native-stacks.js';
export interface RuntimeIncident {
  kind: 'crash' | 'anr'; timestampMs: number; processId: number; processName: string;
  details: string; stack: string[];
  nativeStack?: NativeStack;
}
export function parseRuntimeIncidents(events: string, crashLog: string, packageName: string, sinceMs: number) {
  if (!/^[A-Za-z0-9_.]+$/.test(packageName) || !Number.isFinite(sinceMs) || sinceMs < 0) throw new Error('Invalid diagnostics package or time');
  const parseLine = (line: string) => {
    const match = /^\s*(\d+\.\d+)\s+(\d+)\s+(\d+)\s+[VDIWEF]\s+(\S+)\s*:\s?(.*)$/.exec(line);
    return match ? { timestampMs: Number(match[1]) * 1000, pid: Number(match[2]), tag: match[4], message: match[5]! } : undefined;
  };
  const stacks = crashLog.split(/\r?\n/).map(parseLine).filter(line => line !== undefined);
  const incidents: RuntimeIncident[] = [];
  const nativeStacks = parseNativeStacks(crashLog);
  const seen = new Set<string>();
  let malformedEvents = 0;
  for (const text of events.split(/\r?\n/)) {
    if (!text.includes('am_crash') && !text.includes('am_anr')) continue;
    const line = parseLine(text);
    if (!line || !['am_crash', 'am_anr'].includes(line.tag!)) { malformedEvents++; continue; }
    const match = /^\[\d+,(\d+),([^,]+),-?\d+,(.*)\]$/.exec(line.message);
    if (!match) { malformedEvents++; continue; }
    const processName = match[2]!;
    let processId = Number(match[1]);
    if (line.timestampMs < sinceMs || (processName !== packageName && !processName.startsWith(packageName + ':'))) continue;
    if (line.tag === 'am_crash') {
      const headers = stacks.filter(item => item.tag === 'AndroidRuntime' && item.timestampMs >= sinceMs && item.timestampMs >= line.timestampMs - 5000 && item.timestampMs <= line.timestampMs + 1000 && item.message === `Process: ${processName}, PID: ${item.pid}`);
      const pids = [...new Set(headers.map(item => item.pid))];
      if (pids.length === 1) processId = pids[0]!;
    }
    const nativeCandidates = line.tag === 'am_crash' && /^Native crash(?:,|$)/i.test(match[3]!) ? nativeStacks.filter(item => item.processName === processName && item.timestampMs >= sinceMs && item.timestampMs >= line.timestampMs - 5000 && item.timestampMs <= line.timestampMs + 1000) : [];
    const nativeStack = nativeCandidates.length === 1 ? nativeCandidates[0] : undefined;
    if (nativeStack) processId = nativeStack.processId;
    const key = `${line.timestampMs}:${line.tag}:${processId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // am_crash follows AndroidRuntime output; constrain PID correlation to a short window.
    const stack = line.tag === 'am_crash' ? stacks.filter(item => item.pid === processId && item.tag === 'AndroidRuntime' && item.timestampMs >= sinceMs && item.timestampMs >= line.timestampMs - 5000 && item.timestampMs <= line.timestampMs + 1000).map(item => item.message) : [];
    incidents.push({ kind: line.tag === 'am_crash' ? 'crash' : 'anr', timestampMs: line.timestampMs, processId, processName, details: match[3]!, stack, ...(nativeStack ? { nativeStack } : {}) });
  }
  return { incidents, malformedEvents };
}
