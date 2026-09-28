"""AppVanta request metadata evidence; no headers, cookies or bodies are stored."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

OUTPUT = Path(os.environ['APPVANTA_NETWORK_OUTPUT'])


def running():
    OUTPUT.with_name('proxy-ready.json').write_text(json.dumps({'pid': os.getpid()}), encoding='utf-8')


def save(flow, outcome):
    request = flow.request
    url = urlsplit(request.pretty_url)
    end = flow.response.timestamp_end if flow.response else None
    record = {
        'id': flow.id, 'outcome': outcome, 'method': request.method,
        'url': urlunsplit((url.scheme, url.netloc, url.path, '', '')),
        'startedAt': request.timestamp_start,
        'durationMs': round((end - request.timestamp_start) * 1000, 3) if end else None,
        'statusCode': flow.response.status_code if flow.response else None,
        'clientTls': flow.client_conn.tls,
        'serverTls': flow.server_conn.tls,
        'responseBytes': len(flow.response.raw_content or b'') if flow.response else None,
        'error': str(flow.error) if flow.error else None,
    }
    with OUTPUT.open('a', encoding='utf-8') as target:
        target.write(json.dumps(record) + '\n')


def response(flow):
    save(flow, 'completed')


def error(flow):
    save(flow, 'failed')
