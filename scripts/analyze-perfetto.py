"""Analyze retained scheduler evidence with official Perfetto; never infer missing data as zero."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import sys
from perfetto_cancellation import AnalysisControl, controlled_processor

SQL_VERSION = 'appvanta-sched-v1'

def analyze(trace, package, output, scenario, window_ms=None, processor=None, cancel_file=None):
    from perfetto.trace_processor import TraceProcessorConfig
    if not re.fullmatch(r'[A-Za-z0-9_.]+', package):
        raise ValueError('Invalid package name')
    if window_ms is not None and window_ms < 1:
        raise ValueError('window-ms must be positive')
    trace = Path(trace).resolve(strict=True)
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    summary = {'version': 1, 'status': 'failed', 'trace': str(trace), 'packageName': package, 'queries': []}
    control = AnalysisControl(cancel_file, output)
    try:
        digest = hashlib.sha256()
        with trace.open('rb') as source:
            while True:
                control.check()
                chunk = source.read(1024 * 1024)
                if not chunk: break
                digest.update(chunk)
        summary['traceSha256'] = digest.hexdigest()
        with controlled_processor(control, trace, TraceProcessorConfig(bin_path=processor)) as tp:
            def query(sql):
                control.check()
                summary['queries'].append(sql)
                result = [row.__dict__ for row in tp.query(sql)]
                control.check()
                return result
            summary['processorVersion'] = tp.http.status().human_readable_version
            summary['pythonPackageVersion'] = importlib.metadata.version('perfetto')
            bounds = query('SELECT start_ts, end_ts FROM trace_bounds')[0]
            start, end = bounds['start_ts'], bounds['end_ts']
            if not isinstance(start, int) or not isinstance(end, int) or end <= start:
                raise ValueError('Empty or invalid trace bounds')
            # Fixed trace-clock window makes samples comparable; never stretch a short trace.
            duration_ms = window_ms if window_ms is not None else (end - start) // 1000000
            if duration_ms < 1 or start + duration_ms * 1000000 > end:
                raise ValueError('Trace does not cover the requested analysis window')
            end = start + duration_ms * 1000000
            summary['window'] = {'startNs': start, 'endNs': end, 'durationMs': duration_ms, 'clock': 'trace processor trace clock'}
            problems = query("SELECT name, severity, value FROM stats WHERE severity IN ('error','data_loss') AND value > 0")
            summary['traceProblems'] = problems
            if problems:
                raise ValueError('Trace has parser errors or data loss; metrics withheld')
            if query('SELECT count(*) AS count FROM sched')[0]['count'] == 0:
                raise ValueError('Trace has no scheduling data')
            processes = query(f"SELECT upid, pid, name FROM process WHERE name = '{package}' OR substr(name,1,{len(package)+1}) = '{package}:'")
            if not processes:
                raise ValueError('Requested application is absent from trace process metadata')
            summary['processes'] = processes
            upids = ','.join(str(int(row['upid'])) for row in processes)
            threads = query(f'''SELECT p.pid, t.tid, t.name,
SUM(MAX(0, MIN(CASE WHEN s.dur < 0 THEN {end} ELSE s.ts+s.dur END, {end}) - MAX(s.ts,{start}))) AS scheduled_ns,
COUNT(*) AS slices
FROM sched s JOIN thread t USING(utid) JOIN process p USING(upid)
WHERE p.upid IN ({upids}) AND s.ts < {end} AND (s.dur < 0 OR s.ts+s.dur > {start})
GROUP BY t.utid ORDER BY scheduled_ns DESC''')
            total = sum(row['scheduled_ns'] for row in threads)
            if total < 0 or total > 9007199254740991:
                raise ValueError('Scheduled time cannot be represented safely')
            metadata = query("SELECT str_value FROM metadata WHERE name='android_build_fingerprint'")
            fingerprint = metadata[0]['str_value'] if len(metadata) == 1 else None
            if not fingerprint or len(fingerprint.split('/')) < 3:
                raise ValueError('Trace lacks Android build fingerprint; cannot create comparable measurement')
            measurement = {'version': 2, 'kind': 'measurement', 'context': {
                'platform': 'android', 'deviceModel': fingerprint.split('/')[1], 'osVersion': fingerprint,
                'appId': package, 'scenario': scenario, 'collector': SQL_VERSION,
                'collectorVersion': summary['processorVersion'],
                'sampling': {'durationMs': duration_ms, 'iterations': 1, 'warmupIterations': 0, 'aggregation': 'single'},
            }, 'metrics': {
                'cpu.scheduledTime': {'unit': 'ns', 'value': total},
                'cpu.singleCoreEquivalent': {'unit': 'percent', 'value': total / (end - start) * 100},
            }}
            summary.update(status='passed', threads=threads, measurement='metrics.json')
            step_rows = []
            marker_file = trace.parent / 'step-markers.json'
            if marker_file.exists():
                manifest = json.loads(marker_file.read_text(encoding='utf-8'))
                token = manifest.get('token', '')
                if manifest.get('version') != 1 or not re.fullmatch(r'[0-9a-f-]{36}', token):
                    raise ValueError('Invalid step marker manifest')
                expected = manifest.get('markers')
                if not isinstance(expected, list) or not expected or len(expected) % 2:
                    raise ValueError('Incomplete step marker pairs')
                actual = query(f"SELECT c.ts, t.name, c.value FROM counter c JOIN counter_track t ON c.track_id=t.id WHERE t.name GLOB 'AppVanta:{token}:*' ORDER BY c.ts")
                if len(actual) != len(expected):
                    raise ValueError('Missing or duplicate step markers in trace')
                for i, (record, event) in enumerate(zip(expected, actual)):
                    index, phase = i // 2 + 1, 'begin' if i % 2 == 0 else 'end'
                    name = f'AppVanta:{token}:{index}:{phase}'
                    if record != {'index': index, 'phase': phase, 'marker': name} or event['name'] != name or event['value'] != 1:
                        raise ValueError('Out-of-order or invalid step markers')
                    if i % 2:
                        begin, finish = actual[i - 1]['ts'], event['ts']
                        if finish <= begin:
                            raise ValueError('Invalid step interval')
                        cpu = query(f'''SELECT COALESCE(SUM(MAX(0, MIN(CASE WHEN s.dur < 0 THEN {finish} ELSE s.ts+s.dur END, {finish}) - MAX(s.ts,{begin}))),0) AS scheduled_ns
FROM sched s JOIN thread t USING(utid) WHERE t.upid IN ({upids}) AND s.ts < {finish} AND (s.dur < 0 OR s.ts+s.dur > {begin})''')[0]['scheduled_ns']
                        step_rows.append({'index': index, 'startNs': begin, 'endNs': finish, 'durationNs': finish-begin, 'scheduledCpuNs': cpu})
                summary['steps'] = step_rows
                summary['stepMarkersSha256'] = hashlib.sha256(marker_file.read_bytes()).hexdigest()
            step_table = '' if not step_rows else '\n## Flow steps (full trace clock)\n\n| Step | Duration ms | Scheduled CPU ms |\n|---:|---:|---:|\n' + '\n'.join(f"| {r['index']} | {r['durationNs']/1000000:.3f} | {r['scheduledCpuNs']/1000000:.3f} |" for r in step_rows)
            control.check()
            (output / 'metrics.json').write_text(json.dumps(measurement, indent=2), encoding='utf-8')
            rows = '\n'.join(f"| {r['pid']} | {r['tid']} | {str(r['name']).replace('|', '/')} | {r['scheduled_ns']/1000000:.3f} |" for r in threads)
            (output / 'report.md').write_text(f'''# AppVanta Perfetto analysis

- Application: {package}
- Trace SHA-256: {summary['traceSha256']}
- Analysis window: {duration_ms} ms
- Scheduled CPU time: {total/1000000:.3f} ms
- Single-core equivalent: {total/(end-start)*100:.3f}% (can exceed 100% on multiple cores)
- [Metrics](metrics.json) / [Queries and evidence](analysis.json)

| PID | TID | Thread | Scheduled ms |
|---:|---:|---|---:|
{rows}
{step_table}

Only recorded scheduler execution is measured. This is not CPU frequency-weighted work, frame jank, or proof of a controlled workload. Step intervals, when present, use device trace markers and include observation, actions, checks and recovery; they are not isolated application latency. Step metrics use their full intervals, independently of the overall analysis window. Zero scheduled time is permitted only when process metadata and scheduling data exist. Build product identity is derived from the trace fingerprint.
''', encoding='utf-8')
    except Exception as error:
        summary['status'] = 'cancelled' if control.requested() else 'failed'
        summary['error'] = str(error)
        raise
    finally:
        summary['cancellation'] = control.finish()
        if summary['cancellation']['cleanupError'] or summary['cancellation']['processorExited'] is False:
            summary['status'] = 'failed'
        if summary['cancellation']['requested']:
            summary['status'] = 'cancellation-unverified' if summary['cancellation']['cleanupError'] or summary['cancellation']['processorExited'] is False else 'cancelled'
            for artifact in ['metrics.json', 'report.md']:
                (output / artifact).unlink(missing_ok=True)
        (output / 'analysis.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    control.check()
    if summary['status'] != 'passed':
        raise RuntimeError('Perfetto processor cleanup unverified')
    return {'status': 'passed', 'output': str(output), 'metricsPath': str(output / 'metrics.json'), 'report': str(output / 'report.md')}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--trace', required=True)
    parser.add_argument('--package', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--scenario', default='uncontrolled-trace')
    parser.add_argument('--window-ms', type=int)
    parser.add_argument('--processor')
    parser.add_argument('--cancel-file')
    args = parser.parse_args()
    if not args.scenario.strip(): parser.error('scenario must not be empty')
    try:
        print(json.dumps(analyze(args.trace, args.package, args.output, args.scenario, args.window_ms, args.processor, args.cancel_file)))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
