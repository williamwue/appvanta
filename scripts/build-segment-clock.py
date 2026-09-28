"""Offline, test-only Android visual clock build. Outputs stay under ignored .appvanta."""
import argparse
import os
from pathlib import Path
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--sdk', default=os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT'))
parser.add_argument('--build-tools', default='35.0.0')
parser.add_argument('--platform', default='android-35')
args = parser.parse_args()
if not args.sdk:
    parser.error('--sdk or ANDROID_HOME is required')
root = Path(__file__).resolve().parent.parent
source = root / 'tools/segment-clock'
output = root / '.appvanta/segment-clock'
classes = output / 'classes'
dex = output / 'dex'
classes.mkdir(parents=True, exist_ok=True)
dex.mkdir(parents=True, exist_ok=True)
sdk = Path(args.sdk)
build = sdk / 'build-tools' / args.build_tools
android = sdk / 'platforms' / args.platform / 'android.jar'

def run(*command):
    subprocess.run([str(part) for part in command], check=True)

def tool(name):
    return build / (name + ('.exe' if os.name == 'nt' else ''))

run('javac', '-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', android, '-d', classes, *source.glob('src/**/*.java'))
run('java', '-cp', build / 'lib/d8.jar', 'com.android.tools.r8.D8', '--lib', android, '--min-api', '26', '--output', dex, *classes.glob('**/*.class'))
unsigned = output / 'unsigned.apk'
run(tool('aapt'), 'package', '-f', '-M', source / 'AndroidManifest.xml', '-S', source / 'res', '-I', android, '-F', unsigned)
with zipfile.ZipFile(unsigned, 'a') as archive:
    archive.write(dex / 'classes.dex', 'classes.dex')
aligned = output / 'aligned.apk'
run(tool('zipalign'), '-f', '4', unsigned, aligned)
key = output / 'debug.keystore'
if not key.exists():
    run('keytool', '-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android', '-alias', 'appvanta', '-dname', 'CN=AppVanta Local Segment Clock', '-keyalg', 'RSA', '-validity', '3650')
apk = output / 'appvanta-segment-clock.apk'
run('java', '-jar', build / 'lib/apksigner.jar', 'sign', '--ks', key, '--ks-pass', 'pass:android', '--out', apk, aligned)
run('java', '-jar', build / 'lib/apksigner.jar', 'verify', apk)
print(apk)
