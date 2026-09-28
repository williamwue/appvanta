import type { RuntimeIncident } from './runtime-diagnostics.js';

export interface AnrThread { name: string; tid: number; state: string; lines: string[] }
export function matchAnrStack(dropbox: string, incident: RuntimeIncident) {
  if (incident.kind !== 'anr') return undefined;
  const candidates = [];
  const pattern = /^----- pid (\d+) at ([^\r\n]+) -----\r?\n([\s\S]*?)^----- end \1 -----/gm;
  for (const match of dropbox.matchAll(pattern)) {
    if (Number(match[1]) !== incident.processId) continue;
    const body = match[3]!;
    if (/^Cmd line: (.+)$/m.exec(body)?.[1]?.trim() !== incident.processName) continue;
    // Android timestamps include a timezone and may have nanosecond precision.
    const date = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{4})$/.exec(match[2]!);
    if (!date) continue;
    const timestampMs = Date.parse(`${date[1]}T${date[2]}.${(date[3] ?? '').padEnd(3, '0').slice(0, 3)}${date[4]}`);
    if (!Number.isFinite(timestampMs) || Math.abs(timestampMs - incident.timestampMs) > 10000) continue;
    const threads: AnrThread[] = [];
    let current: AnrThread | undefined;
    for (const line of body.split(/\r?\n/)) {
      const header = /^"([^"]+)".*?\btid=(\d+)\s+(.*)$/.exec(line);
      if (header) { current = { name: header[1]!, tid: Number(header[2]), state: header[3]!, lines: [line] }; threads.push(current); }
      else if (line.startsWith('"')) current = undefined;
      else if (current && line.trim()) current.lines.push(line);
    }
    if (threads.length) candidates.push({ timestampMs, threads, raw: match[0] });
  }
  candidates.sort((a, b) => Math.abs(a.timestampMs - incident.timestampMs) - Math.abs(b.timestampMs - incident.timestampMs));
  return candidates[0];
}
