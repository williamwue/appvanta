import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { FlowDefinition, DeviceId } from '@appvanta/core';
import { AdbDriver } from './adb-driver.js';
import { parsePermissionSnapshot } from './permission-fixture.js';

export async function collectFlowEnvironment(driver: AdbDriver, device: DeviceId, flow: FlowDefinition) {
  const packages = new Set(flow.applications ?? []);
  for (const name of flow.resetApplications ?? []) packages.add(name);
  if (flow.inputMethod) packages.add(flow.inputMethod.split('/')[0]!);
  for (const name of flow.diagnostics?.packages ?? []) packages.add(name);
  const add = (step: { launchPackage?: string; action?: { kind: string; condition?: { kind: string; packageName?: string } } }) => {
    if (step.launchPackage) packages.add(step.launchPackage);
    if (step.action?.condition?.kind === 'app-running' && step.action.condition.packageName) packages.add(step.action.condition.packageName);
  };
  for (const step of flow.steps) { add(step); for (const rule of step.recovery?.rules ?? []) add(rule); }
  for (const op of flow.appOps ?? []) packages.add(op.packageName);
  for (const permission of flow.permissions ?? []) packages.add(permission.packageName);
  const applications = [];
  for (const name of [...packages].sort()) applications.push(await driver.applicationIdentity(device, name));
  const permissions = [];
  if (flow.permissions?.length) {
    const runShell = async (...args: string[]) => (await promisify(execFile)('adb', ['-s', device, 'shell', ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true })).stdout;
    const userId = Number((await runShell('am', 'get-current-user')).trim());
    if (!Number.isSafeInteger(userId) || userId < 0) throw new Error('Cannot determine Android user for environment evidence');
    for (const fixture of [...flow.permissions].sort((left, right) => `${left.packageName}/${left.permission}`.localeCompare(`${right.packageName}/${right.permission}`))) {
      const { granted, flags } = parsePermissionSnapshot(await runShell('dumpsys', 'package', fixture.packageName), fixture.packageName, fixture.permission, userId);
      permissions.push({ packageName: fixture.packageName, permission: fixture.permission, userId, granted, flags });
    }
  }
  const adbOutput = (await promisify(execFile)('adb', ['version'], { encoding: 'utf8', timeout: 20000, windowsHide: true })).stdout;
  const adb = adbOutput.split(/\r?\n/).filter(line => /^Android Debug Bridge version |^Version /.test(line)).join('; ');
  if (!adb) throw new Error('Cannot determine ADB version');
  const hash = createHash('sha256');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  // Fingerprint executable JS, not git revision (which can hide uncommitted changes).
  for (const pkg of ['core', 'android']) {
    const directory = join(root, pkg, 'dist');
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.js') || name.endsWith('.mjs')).sort()) {
      hash.update(`${pkg}/${file}\0`); hash.update(await readFile(join(directory, file))); hash.update('\0');
    }
  }
  return { version: 1, scope: 'declared-applications', host: { node: process.version, adb, platform: process.platform, arch: process.arch, runtimeSha256: hash.digest('hex') }, applications, ...(permissions.length ? { permissions } : {}) };
}
