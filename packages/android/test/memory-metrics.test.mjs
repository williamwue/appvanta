import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemoryMetrics } from '../dist/memory-metrics.js';

const header = 'Applications Memory Usage (in Kilobytes):\n';
const process = (pid, name) => `** MEMINFO in pid ${pid} [${name}] **\n TOTAL PSS: 1024 TOTAL RSS: 2048 TOTAL SWAP PSS: 0\n`;
test('memory parser sums app processes, converts units and rejects missing or ambiguous evidence', () => {
  const valid = header + process(10, 'app.test') + process(11, 'app.test:service');
  const result = parseMemoryMetrics(valid, 'app.test');
  assert.equal(result.metrics['memory.pss'].value, 2097152);
  assert.equal(result.metrics['memory.rss'].value, 4194304);
  assert.equal(result.metrics['memory.processCount'].value, 2);
  for (const invalid of [header + 'No process found', valid.replace('Kilobytes', 'Bytes'),
    header + process(10, 'other.app'), header + process(10, 'app.test') + process(10, 'app.test'),
    valid.replace('TOTAL RSS: 2048', ''), valid.replace('TOTAL PSS: 1024', 'TOTAL PSS: -1'),
    valid.replace('TOTAL PSS: 1024', 'TOTAL PSS: 1.5'), valid.replace('TOTAL PSS: 1024', 'TOTAL PSS: 9007199254740991'),
    valid + 'TOTAL PSS: 123\n']) assert.throws(() => parseMemoryMetrics(invalid, 'app.test'));
});
