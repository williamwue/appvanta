import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readMcpResponses } from '../../mcp-response-reader.mjs';

export async function mcpExchange(lines, ids, env = process.env) {
  const child = spawn(process.execPath, ['packages/mcp/dist/index.js'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    const received = readMcpResponses(child.stdout, ids, 30000);
    child.stdin.write(lines.join('\n') + '\n');
    const messages = await received;
    child.stdin.end();
    let timer;
    const [status] = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('MCP did not exit after completed exchange')), 5000);
    })]).finally(() => clearTimeout(timer));
    return { status, stderr, stdout: messages.map(JSON.stringify).join('\n') };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
}
