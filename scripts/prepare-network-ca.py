"""Copy only the public test CA to Android and print its fingerprint for installation."""
import argparse
import json
from pathlib import Path
import subprocess
from cryptography import x509
from cryptography.hazmat.primitives import hashes

parser = argparse.ArgumentParser()
parser.add_argument('--device', required=True)
parser.add_argument('--ca-dir', default='.appvanta/network-ca')
args = parser.parse_args()
path = Path(args.ca_dir) / 'mitmproxy-ca-cert.pem'
raw = path.read_bytes()
if b'PRIVATE KEY' in raw:
    raise ValueError('Refusing to copy a private key to a device')
cert = x509.load_pem_x509_certificate(raw)
fingerprint = cert.fingerprint(hashes.SHA256()).hex()
remote = '/sdcard/Download/appvanta-test-ca.crt'
subprocess.run(['adb', '-s', args.device, 'push', str(path), remote], check=True, timeout=20)
print(json.dumps({'device': args.device, 'certificate': remote, 'sha256': fingerprint,
                  'status': 'copied-not-installed', 'subject': cert.subject.rfc4514_string()}))
