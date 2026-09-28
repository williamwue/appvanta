import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startNetwork } from '../packages/android/dist/network-session.js';

const device = process.argv[2];
assert(/^emulator-\d+$/.test(device ?? ''), 'Specify an emulator serial; this test reboots it');
const root = resolve('.appvanta/runs', `network-reconnect-${Date.now()}`);
await mkdir(root, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const original = adb('shell', 'settings', 'get', 'global', 'http_proxy');
await writeFile(join(root, 'before.json'), JSON.stringify({ device, original }));
const session = await startNetwork({ python: 'python', mitmdump: resolve('.appvanta/proxy-venv/Scripts/mitmdump.exe'), port: 18089 }, device, root);
const started = Date.now();
let failure;
try {
  assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), '10.0.2.2:18089');
  adb('reboot');
} catch (error) { failure = error; }
try { await session.stop(); } catch (error) { failure ??= error; }
const summary = JSON.parse(await readFile(join(root, 'network/summary.json'), 'utf8'));
const attempts = (await readFile(join(root, 'network/restoration.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: failure ? 'failed' : 'pending', device, original, elapsedMs: Date.now() - started, summary, attempts, error: failure?.message }, null, 2));
if (failure) throw failure;
assert(attempts.some(item => item.status === 'retry'), 'No observed ADB failure; reconnect was not exercised');
assert.equal(attempts.at(-1).status, 'restored');
assert.equal(summary.proxyRestored, true);
assert.equal(summary.proxyStopped, true);
assert.equal(adb('shell', 'settings', 'get', 'global', 'http_proxy'), original);
await writeFile(join(root, 'verification.json'), JSON.stringify({ status: 'passed', device, original, elapsedMs: Date.now() - started, summary, attempts }, null, 2));
console.log(JSON.stringify({ status: 'passed', root, attempts: attempts.length }));
