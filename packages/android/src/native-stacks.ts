export interface NativeStack {
  processId: number; threadId: number; processName: string; timestampMs: number;
  signal: string; abortMessage?: string; frames: string[]; lines: string[];
}
/** DEBUG log headers identify the crashing PID; the log writer can be crash_dump. */
export function parseNativeStacks(log: string): NativeStack[] {
  const blocks = new Map<number, { timestampMs: number; lines: string[] }>();
  const completed: { timestampMs: number; lines: string[] }[] = [];
  for (const line of log.split(/\r?\n/)) {
    const match = /^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+[VDIWEF]\s+DEBUG\s*:\s?(.*)$/.exec(line);
    if (!match) continue;
    const writer = Number(match[2]), message = match[3]!;
    if (message.startsWith('*** *** ***')) {
      const previous = blocks.get(writer);
      if (previous) completed.push(previous);
      blocks.set(writer, { timestampMs: Number(match[1]) * 1000, lines: [] });
    }
    blocks.get(writer)?.lines.push(message);
  }
  completed.push(...blocks.values());
  return completed.flatMap(block => {
    const header = block.lines.map(line => /^pid: (\d+),.*?tid: (\d+),.*?>>> (.+) <<<$/.exec(line)).find(Boolean);
    const signal = block.lines.find(line => /^signal \d+ \(SIG[A-Z0-9]+\)/.test(line));
    const frames = block.lines.filter(line => /^\s*#\d+\s+pc\s+[0-9a-f]+\s+/i.test(line));
    if (!header || !signal || !frames.length) return [];
    const abortMessage = block.lines.find(line => line.startsWith('Abort message:'));
    return [{ processId: Number(header[1]), threadId: Number(header[2]), processName: header[3]!, timestampMs: block.timestampMs,
      signal, ...(abortMessage ? { abortMessage } : {}), frames, lines: block.lines }];
  });
}
