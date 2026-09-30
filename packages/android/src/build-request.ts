import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export async function writeGradleBridgeRequest(path: string, request: {
  installation: string; project: string; userHome: string; receipt: string;
  tasks: string[]; arguments: string[];
}) {
  if ([request.installation, request.project, request.userHome, request.receipt].some(value => typeof value !== 'string' || !isAbsolute(value))) throw new Error('Absolute Gradle request paths required');
  if (!Array.isArray(request.tasks) || request.tasks.length < 1 || request.tasks.length > 256
    || request.tasks.some(task => typeof task !== 'string' || !task.trim() || task.startsWith('-'))
    || !Array.isArray(request.arguments) || request.arguments.length > 1024) throw new Error('Invalid Gradle task or argument list');
  const values = [request.installation, request.project, request.userHome, request.receipt,
    String(request.tasks.length), ...request.tasks, ...request.arguments];
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(8); header.writeUInt32BE(0x41564731); header.writeUInt32BE(values.length, 4); chunks.push(header);
  let bytes = header.length;
  for (const value of values) {
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid Gradle request string');
    const encoded = Buffer.from(value, 'utf8');
    if (encoded.toString('utf8') !== value || encoded.length > 1024 * 1024) throw new Error('Invalid or oversized UTF-8 request field');
    const length = Buffer.alloc(4); length.writeUInt32BE(encoded.length);
    chunks.push(length, encoded); bytes += length.length + encoded.length;
    if (bytes > 4 * 1024 * 1024) throw new Error('Gradle request exceeds 4 MiB');
  }
  const requestPath = resolve(path);
  const content = Buffer.concat(chunks);
  await writeFile(requestPath, content, { flag: 'wx', mode: 0o600 });
  return { requestPath, requestSha256: createHash('sha256').update(content).digest('hex'),
    launcherArguments: ['--request-base64', Buffer.from(requestPath, 'utf8').toString('base64')] };
}
