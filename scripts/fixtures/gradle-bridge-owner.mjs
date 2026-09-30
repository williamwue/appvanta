import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const [receipt, executable, ...args] = process.argv.slice(2);
if (!receipt || !executable) throw new Error('Owner receipt and executable are required');
const bridge = spawn(executable, args, { detached: true, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
process.stdin.pipe(bridge.stdin);
bridge.stdin.on('error', error => { if (error.code !== 'EPIPE') { console.error(error); process.exitCode = 1; } });
bridge.once('spawn', () => {
  void writeFile(receipt, JSON.stringify({ ownerPid: process.pid, parentPid: process.ppid, bridgePid: bridge.pid, bridgeDetached: true }), { flag: 'wx' }).catch(error => {
    console.error(error); process.exitCode = 1; bridge.stdin.end();
  });
});
bridge.once('error', error => { console.error(error); process.stdin.destroy(); process.exitCode = 1; });
bridge.once('exit', code => {
  process.stdin.unpipe(bridge.stdin);
  process.stdin.destroy();
  process.exitCode = process.exitCode || (code ?? 1);
});
