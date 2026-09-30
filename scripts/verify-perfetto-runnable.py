"""Check analyzer results against raw thread states from a retained Android trace."""
import argparse
import importlib.util
import json
from pathlib import Path
from perfetto.trace_processor import TraceProcessor

parser = argparse.ArgumentParser()
parser.add_argument('--trace', required=True)
parser.add_argument('--package', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--window-ms', type=int, default=6000)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('analyzer', Path(__file__).with_name('analyze-perfetto.py'))
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)
result = analyzer.analyze(args.trace, args.package, args.output, 'retained-runnable-verification', args.window_ms)
root = Path(result['output'])
analysis = json.loads((root / 'analysis.json').read_text())
measurement = json.loads((root / 'metrics.json').read_text())
start, end = analysis['window']['startNs'], analysis['window']['endNs']
upids = ','.join(str(row['upid']) for row in analysis['processes'])
with TraceProcessor(trace=args.trace) as tp:
    raw = [row.__dict__ for row in tp.query(
        f'SELECT s.ts,s.dur,s.state FROM thread_state s JOIN thread t USING(utid) WHERE t.upid IN ({upids})')]
overlapping = [row for row in raw if row['ts'] < end and (row['dur'] < 0 or row['ts'] + row['dur'] > start)]
complete = [row for row in overlapping if row['state'] in ('R', 'R+') and row['dur'] >= 0]
unfinished = [row for row in overlapping if row['state'] in ('R', 'R+') and row['dur'] < 0]
total = sum(max(0, min(end, row['ts'] + row['dur']) - max(start, row['ts'])) for row in complete)
assert len(complete) > 0, 'This verification requires observed runnable intervals'
assert measurement['metrics']['cpu.observedRunnableTime'] == {'unit': 'ns', 'value': total}
assert analysis['runnableEvidence']['state_rows'] == len(overlapping)
assert analysis['runnableEvidence']['completed_slices'] == len(complete)
assert analysis['runnableEvidence']['incomplete_slices'] == len(unfinished)
assert measurement['context']['collector'] == 'appvanta-sched-v2'
evidence = {'status': 'passed', 'traceSha256': analysis['traceSha256'], 'rawStateRows': len(raw),
            'overlappingStateRows': len(overlapping), 'completedRunnableSlices': len(complete),
            'unfinishedRunnableSlices': len(unfinished), 'independentRunnableNs': total,
            'scope': 'Retained trace raw-state integration; no claim of complete wakeup collection'}
(root / 'runnable-verification.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
print(json.dumps({**evidence, 'output': str(root)}))
