"""Always preserve a session summary, including cleanup and evidence failures."""
import json
import subprocess


def finalize(process, output, summary):
    errors = []
    forced = False
    stopped = process is None
    if process is not None:
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    forced = True
                    process.kill()
                    process.wait(timeout=10)
            stopped = process.poll() is not None
        except Exception as error:
            errors.append({'phase': 'proxy-stop', 'error': str(error)})
    count = 0
    invalid = []
    try:
        # Stream the log; retain its original bytes even if a final write tore.
        with output.open('rb') as stream:
            for number, line in enumerate(stream, 1):
                try:
                    record = json.loads(line.decode('utf-8'))
                    if not isinstance(record, dict):
                        raise ValueError('Request record must be an object')
                    count += 1
                except (ValueError, UnicodeError):
                    invalid.append(number)
        if invalid:
            errors.append({'phase': 'request-log', 'error': 'Invalid request records', 'lines': invalid})
    except OSError as error:
        errors.append({'phase': 'request-log', 'error': str(error)})
    if forced:
        errors.append({'phase': 'proxy-stop', 'error': 'Proxy required forced termination; request log may be incomplete'})
    if not stopped and not any(item['phase'] == 'proxy-stop' for item in errors):
        errors.append({'phase': 'proxy-stop', 'error': 'Proxy process is still running'})
    result = {**summary, 'requests': count, 'proxyStopped': stopped, 'forcedTermination': forced, 'cleanupErrors': errors}
    if errors:
        result['status'] = 'failed'
    output.with_name('summary.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result
