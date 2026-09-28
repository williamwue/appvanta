"""Exercise the Android browser through a real proxy against a local fixture."""
import http.server
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import argparse
import ssl
import tempfile


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'AppVanta network fixture')

    def log_message(self, *_):
        pass


parser = argparse.ArgumentParser()
parser.add_argument('device', nargs='?', default='emulator-5554')
parser.add_argument('--https', action='store_true')
parser.add_argument('--reject-upstream', action='store_true', help='Verify an untrusted TLS origin is rejected')
parser.add_argument('--flow', action='store_true', help='Exercise the CLI Flow-owned network session')
parser.add_argument('--mcp', action='store_true', help='Execute the same Flow via the MCP server')
parser.add_argument('--fail-flow', action='store_true', help='Verify failing assertions preserve evidence and restore proxy')
parser.add_argument('--fail-network', action='store_true', help='Verify occupied proxy port stops the Flow before actions')
args = parser.parse_args()
if args.mcp and not args.flow:
    parser.error('--mcp requires --flow')
if args.reject_upstream and not args.https:
    parser.error('--reject-upstream requires --https')
if args.fail_flow and not args.flow:
    parser.error('--fail-flow requires --flow')
if args.fail_network and not args.flow:
    parser.error('--fail-network requires --flow')
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
key_directory = tempfile.TemporaryDirectory(prefix='appvanta-tls-')
tls_args = []
scheme = 'https' if args.https else 'http'
if args.https:
    import datetime
    import ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    ca_dir = Path('.appvanta/network-ca')
    ca = x509.load_pem_x509_certificate((ca_dir / 'mitmproxy-ca-cert.pem').read_bytes())
    ca_key = serialization.load_pem_private_key((ca_dir / 'mitmproxy-ca.pem').read_bytes(), password=None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'AppVanta TLS fixture')]))
            .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=1)).not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
            .sign(ca_key, hashes.SHA256()))
    key_path = Path(key_directory.name) / 'key.pem'
    cert_path = Path(key_directory.name) / 'cert.pem'
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    if not args.reject_upstream:
        tls_args = ['--upstream-ca', str(ca_dir / 'mitmproxy-ca-cert.pem')]
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
serial = args.device
root = Path('.appvanta/runs') / f'network-{time.time_ns()}'
command = ['adb', '-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy']
before = subprocess.check_output(command, text=True).strip()
try:
    if args.flow:
        network = {'python': sys.executable, 'mitmdump': str(Path('.appvanta/proxy-venv/Scripts/mitmdump.exe').resolve()),
                   'mapRemote': f'|{scheme}://appvanta.test/|{scheme}://127.0.0.1:{server.server_port}/'}
        if tls_args:
            network['upstreamCa'] = tls_args[1]
        if args.fail_network:
            network['port'] = server.server_port
        flow = {'name': 'Network lifecycle verification', 'network': network,
                'steps': [{'description': 'Open fixture and verify page', 'openUrl': f'{scheme}://appvanta.test/appvanta-fixture',
                           'assertText': 'AppVanta network fixture'}]}
        if args.fail_flow:
            flow['steps'].append({'description': 'Deliberate assertion failure', 'assertText': 'APPVANTA_IMPOSSIBLE_ASSERTION'})
        flow_path = Path(key_directory.name) / 'flow.json'
        flow_path.write_text(json.dumps(flow), encoding='utf-8')
        if args.mcp:
            request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'run_flow', 'arguments': {'deviceId': serial, 'flow': flow}}}
            handshake = [{'jsonrpc': '2.0', 'id': 'init', 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'verifier', 'version': '1'}}}, {'jsonrpc': '2.0', 'method': 'notifications/initialized'}]
            executed = subprocess.run(['node', 'packages/mcp/dist/index.js'], input='\n'.join(json.dumps(item) for item in [*handshake, request]) + '\n', capture_output=True, text=True, encoding='utf-8', timeout=120)
            reply = next(item for item in map(json.loads, executed.stdout.splitlines()) if item.get('id') == 1)
            assert 'error' not in reply, reply
            outcome = json.loads(reply['result']['content'][0]['text'])
        else:
            executed = subprocess.run(['node', 'packages/cli/dist/index.js', 'run-flow', serial, str(flow_path)], capture_output=True, text=True, encoding='utf-8', timeout=120)
            outcome = json.loads(executed.stdout)
        root = Path(outcome['runDirectory'])
        expected = 'failed' if args.fail_flow or args.fail_network else 'passed'
        assert outcome['status'] == expected, outcome
        assert executed.returncode == (1 if not args.mcp and (args.fail_flow or args.fail_network) else 0), executed.stderr
        assert json.loads((root / 'run.json').read_text())['status'] == expected
        assert 'network/requests.jsonl' in (root / 'report.md').read_text()
        if args.fail_network:
            assert len(outcome['steps']) == 1 and outcome['steps'][0]['description'] == 'Initialize Flow resources'
        elif args.fail_flow:
            assert outcome['steps'][-1]['evidence'], 'Failure screenshot/UI evidence missing'
        network_root = root / 'network'
    else:
        subprocess.run([sys.executable, 'scripts/capture-network.py', '--mitmdump',
                    str(Path('.appvanta/proxy-venv/Scripts/mitmdump.exe').resolve()),
                    '--device', serial, '--output', str(root), '--seconds', '12',
                    '--map-remote', f'|{scheme}://appvanta.test/|{scheme}://127.0.0.1:{server.server_port}/',
                    '--open-url', f'{scheme}://appvanta.test/appvanta-fixture', *tls_args], check=True)
        network_root = root
    rows = [json.loads(line) for line in (network_root / 'requests.jsonl').read_text().splitlines()]
    fixture_rows = [row for row in rows if row['url'].endswith('/appvanta-fixture')]
    if args.fail_network:
        assert not rows, 'Flow ran despite proxy startup failure'
    elif args.reject_upstream:
        assert fixture_rows and not any(row['statusCode'] == 200 for row in fixture_rows), 'Untrusted TLS origin was accepted'
        assert any('certificate verify failed' in (row['error'] or '').lower() for row in fixture_rows), 'Missing certificate rejection evidence'
    else:
        assert any(row['statusCode'] == 200 and (not args.https or (row['clientTls'] and row['serverTls'])) for row in fixture_rows), 'No verified Android fixture response captured'
    assert subprocess.check_output(command, text=True).strip() == before, 'Proxy was not restored'
    assert json.loads((network_root / 'summary.json').read_text())['proxyRestored'] is True
    result = {'status': 'passed', 'scheme': scheme, 'flow': args.flow, 'mcp': args.mcp, 'failFlow': args.fail_flow, 'failNetwork': args.fail_network, 'rejectUpstream': args.reject_upstream, 'evidence': str(root), 'proxyRestored': True}
    (root / 'verification.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
finally:
    server.shutdown()
    server.server_close()
    key_directory.cleanup()
