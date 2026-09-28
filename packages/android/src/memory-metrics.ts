/** Parse per-process App Summary totals, never global/device totals. */
export function parseMemoryMetrics(output: string, packageName: string) {
  if (!output.includes('Applications Memory Usage (in Kilobytes)')) throw new Error('Unsupported memory output units');
  const sections = [...output.matchAll(/\*\* MEMINFO in pid (\d+) \[([^\]]+)\] \*\*/g)];
  if (!sections.length) throw new Error('No process memory summary; app may not be running');
  const seen = new Set<string>();
  const processes = sections.map((section, index) => {
    const pid = section[1]!, name = section[2]!;
    if ((name !== packageName && !name.startsWith(packageName + ':')) || seen.has(pid)) throw new Error('Unexpected or duplicate process in memory summary');
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) < 1) throw new Error('Invalid process ID');
    seen.add(pid);
    const text = output.slice(section.index! + section[0].length, sections[index + 1]?.index ?? output.length);
    const total = (label: string) => {
      const matches = [...text.matchAll(new RegExp(`\\b${label}:\\s*(\\d+)(?=\\s|$)`, 'g'))];
      if (matches.length !== 1) throw new Error(`Missing or ambiguous ${label} for ${name}`);
      const bytes = Number(matches[0]![1]) * 1024;
      if (!Number.isSafeInteger(bytes)) throw new Error(`Invalid ${label} for ${name}`);
      return bytes;
    };
    return { pid: Number(pid), name, pssBytes: total('TOTAL PSS'), rssBytes: total('TOTAL RSS'), swapPssBytes: total('TOTAL SWAP PSS') };
  });
  const sum = (key: 'pssBytes' | 'rssBytes' | 'swapPssBytes') => {
    const value = processes.reduce((sum, process) => sum + process[key], 0);
    if (!Number.isSafeInteger(value)) throw new Error('Memory total overflow');
    return value;
  };
  return { processes, metrics: {
    'memory.pss': { unit: 'bytes' as const, value: sum('pssBytes') },
    'memory.rss': { unit: 'bytes' as const, value: sum('rssBytes') },
    'memory.swapPss': { unit: 'bytes' as const, value: sum('swapPssBytes') },
    'memory.processCount': { unit: 'count' as const, value: processes.length },
  } };
}
