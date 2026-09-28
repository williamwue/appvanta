import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { brand } from '@appvanta/core';
import type { DiagnosticsConfig } from '@appvanta/core';
import { AdbDriver } from './adb-driver.js';

export async function startFlowDiagnostics(config: DiagnosticsConfig, device: string, root: string) {
  const directory = join(root, 'diagnostics');
  await mkdir(directory, { recursive: true });
  const since = (await promisify(execFile)('adb', ['-s', device, 'shell', 'date', '+%s.%N'], { encoding: 'utf8', timeout: 20000, windowsHide: true })).stdout.trim();
  if (!/^\d+\.\d+$/.test(since)) throw new Error('Device does not provide precise diagnostics start time');
  const driver = new AdbDriver({ artifactsDirectory: directory });
  await writeFile(join(directory, 'session.json'), JSON.stringify({ version: 1, since, packages: config.packages }, null, 2));
  return { stop: async () => {
    const results = [];
    let failed = false;
    for (const packageName of config.packages) {
      try {
        const result = await driver.diagnoseRuntime(brand(device), brand(packageName), since);
        const status = result.crashCount || result.anrCount || result.malformedEvents ? 'failed' : 'passed';
        failed ||= status === 'failed';
        results.push({ packageName, status, crashCount: result.crashCount, anrCount: result.anrCount, malformedEvents: result.malformedEvents,
          report: relative(root, result.diagnosticsPath).replaceAll('\\', '/') });
      } catch (error) { failed = true; results.push({ packageName, status: 'failed', error: String(error) }); }
    }
    await writeFile(join(directory, 'summary.json'), JSON.stringify({ version: 1, status: failed ? 'failed' : 'passed', since, coverage: 'retained-logcat-events', results }, null, 2));
    if (failed) throw new Error('Runtime diagnostics detected incidents or incomplete collection; see diagnostics/summary.json');
  } };
}
