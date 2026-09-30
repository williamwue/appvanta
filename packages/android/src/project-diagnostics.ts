import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

export interface ProjectFinding {
  readonly code: string;
  readonly remediation: string;
  readonly path?: string;
  readonly line?: number;
}
export interface AndroidProjectReport {
  readonly version: 1;
  readonly projectDirectory: string;
  readonly identification: 'android-gradle-candidate' | 'gradle-candidate' | 'unrecognized';
  readonly configurationEvaluated: false;
  readonly buildExecuted: false;
  readonly files: readonly { path: string; kind: string; bytes: number; sha256: string }[];
  readonly wrapper: { filesPresent: boolean; missing: readonly string[] };
  readonly scan: { complete: boolean; entriesVisited: number; excludedDirectories: readonly string[]; skipped: readonly { path: string; reason: string }[] };
  readonly findings: readonly ProjectFinding[];
  readonly log?: { path: string; bytes: number; sha256: string; outcomeMarker: 'passed' | 'failed' | 'unknown'; findings: readonly ProjectFinding[] };
}

const kinds = new Map([
  ['settings.gradle', 'settings-groovy'], ['settings.gradle.kts', 'settings-kotlin'],
  ['build.gradle', 'build-groovy'], ['build.gradle.kts', 'build-kotlin'],
  ['gradlew', 'wrapper-script'], ['gradlew.bat', 'wrapper-script'],
  ['gradle-wrapper.jar', 'wrapper-jar'], ['gradle-wrapper.properties', 'wrapper-properties'],
  ['gradle.properties', 'gradle-properties'], ['local.properties', 'local-properties'],
  ['AndroidManifest.xml', 'android-manifest'], ['libs.versions.toml', 'version-catalog'],
]);
const excluded = ['.git', '.gradle', '.idea', '.appvanta', 'node_modules', 'build', 'dist', '.venv'];
const wrapperFiles = ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties'];
const rules: readonly { code: string; pattern: RegExp; remediation: string }[] = [
  { code: 'sdk-location', pattern: /SDK location not found/i, remediation: 'Configure the Android SDK location in local.properties or ANDROID_HOME, then verify that directory exists.' },
  { code: 'sdk-license', pattern: /(?:licenses? (?:have |has )?not been accepted|licenses? .*not accepted)/i, remediation: 'Review and accept the required Android SDK licenses using the SDK manager.' },
  { code: 'java-version', pattern: /(?:Android Gradle plugin requires Java|Unsupported class file major version|invalid source release|invalid target release)/i, remediation: 'Check the project Gradle, Android plugin and Java toolchain compatibility; select the required JDK.' },
  { code: 'java-location', pattern: /(?:JAVA_HOME is not set|JAVA_HOME is set to an invalid directory)/i, remediation: 'Set JAVA_HOME to an installed JDK and verify its java executable.' },
  { code: 'dependency-resolution', pattern: /(?:Could not resolve all (?:files|dependencies)|Could not find [\w.-]+:[\w.-]+:)/i, remediation: 'Inspect dependency coordinates, configured repositories, credentials and network access for the failing configuration.' },
  { code: 'manifest-merger', pattern: /Manifest merger failed/i, remediation: 'Inspect the manifest merger report for the failing variant and resolve its conflicting declarations.' },
  { code: 'android-resources', pattern: /Android resource linking failed/i, remediation: 'Inspect the reported resource location and the variant resource dependencies and compile SDK.' },
  { code: 'duplicate-classes', pattern: /Duplicate class .+ found in modules/i, remediation: 'Inspect the dependency graph and align or exclude the duplicate artifacts.' },
  { code: 'signing', pattern: /(?:Keystore file .+ not found|Failed to read key .+ from store)/i, remediation: 'Check the selected signing configuration and locally supplied keystore; do not publish passwords or keys.' },
];

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Expected a regular file');
  const handle = await open(path, 'r');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > maximum) throw new Error(`File exceeds ${maximum} byte limit or is not regular`);
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error(`File exceeds ${maximum} byte limit`);
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function inspectAndroidProject(options: { projectDirectory: string; buildLogPath?: string; signal?: AbortSignal }): Promise<AndroidProjectReport> {
  if (typeof options.projectDirectory !== 'string' || !options.projectDirectory.trim()) throw new Error('Project directory is required');
  options.signal?.throwIfAborted();
  const root = await realpath(resolve(options.projectDirectory));
  if (!(await lstat(root)).isDirectory()) throw new Error('Project path must be a directory');
  const files: AndroidProjectReport['files'][number][] = [];
  const skipped: { path: string; reason: string }[] = [];
  const queue = [{ path: root, depth: 0 }];
  let entriesVisited = 0, totalBytes = 0;
  const rel = (path: string) => relative(root, path).replaceAll('\\', '/');
  while (queue.length && entriesVisited < 5000) {
    const item = queue.shift()!;
    options.signal?.throwIfAborted();
    if ((await lstat(item.path)).isSymbolicLink()) { skipped.push({ path: rel(item.path), reason: 'symbolic-link' }); continue; }
    try {
      const directory = await opendir(item.path);
      for await (const entry of directory) {
        options.signal?.throwIfAborted();
        if (++entriesVisited > 5000) { skipped.push({ path: rel(item.path), reason: 'entry-limit' }); break; }
        const path = join(item.path, entry.name);
        if (entry.isSymbolicLink()) { skipped.push({ path: rel(path), reason: 'symbolic-link' }); continue; }
        if (entry.isDirectory() && !excluded.includes(entry.name)) {
          if (item.depth >= 8) skipped.push({ path: rel(path), reason: 'depth-limit' });
          else queue.push({ path, depth: item.depth + 1 });
        }
        const kind = kinds.get(entry.name);
        if (!kind || !entry.isFile()) continue;
        if (totalBytes >= 16 * 1024 * 1024) { skipped.push({ path: rel(path), reason: 'byte-budget' }); continue; }
        try {
          const bytes = await boundedFile(path, Math.min(1024 * 1024, 16 * 1024 * 1024 - totalBytes));
          totalBytes += bytes.length;
          files.push({ path: rel(path), kind, bytes: bytes.length, sha256: digest(bytes) });
        } catch { skipped.push({ path: rel(path), reason: 'unreadable-or-oversized-file' }); }
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      skipped.push({ path: rel(item.path), reason: 'unreadable-directory' });
    }
  }
  if (queue.length) skipped.push({ path: '.', reason: 'entry-limit' });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set(files.map(file => file.path));
  const hasGradle = files.some(file => file.kind.startsWith('build-') || file.kind.startsWith('settings-'));
  const missing = wrapperFiles.filter(path => !paths.has(path));
  const findings: ProjectFinding[] = [];
  if (hasGradle && missing.length) findings.push({ code: 'wrapper-incomplete', remediation: 'Review missing wrapper files at this directory. Confirm the actual build root and restore its trusted Gradle wrapper files.' });
  for (const file of files) {
    if (['build.gradle', 'settings.gradle'].includes(basename(file.path)) && paths.has(file.path + '.kts')) findings.push({ code: 'conflicting-build-scripts', path: file.path, remediation: 'Both Groovy and Kotlin scripts exist at this location; confirm which script the build uses.' });
  }
  let log: AndroidProjectReport['log'];
  if (options.buildLogPath !== undefined) {
    if (typeof options.buildLogPath !== 'string' || !options.buildLogPath.trim()) throw new Error('Build log path must be nonempty');
    const path = resolve(options.buildLogPath), bytes = await boundedFile(path, 2 * 1024 * 1024);
    const matches: ProjectFinding[] = [];
    let outcomeMarker: 'passed' | 'failed' | 'unknown' = 'unknown';
    const seen = new Set<string>();
    for (const [index, raw] of bytes.toString('utf8').split(/\r?\n/).entries()) {
      options.signal?.throwIfAborted();
      const line = raw.replace(/\u001b\[[0-9;]*m/g, '');
      if (/^BUILD SUCCESSFUL(?:\s|$)/.test(line)) outcomeMarker = 'passed';
      if (/^BUILD FAILED(?:\s|$)/.test(line)) outcomeMarker = 'failed';
      for (const rule of rules) if (!seen.has(rule.code) && rule.pattern.test(line)) {
        seen.add(rule.code);
        matches.push({ code: rule.code, line: index + 1, remediation: rule.remediation });
      }
    }
    log = { path, bytes: bytes.length, sha256: digest(bytes), outcomeMarker, findings: matches };
  }
  options.signal?.throwIfAborted();
  return { version: 1, projectDirectory: root, identification: !hasGradle ? 'unrecognized' : files.some(file => file.kind === 'android-manifest') ? 'android-gradle-candidate' : 'gradle-candidate', configurationEvaluated: false, buildExecuted: false, files, wrapper: { filesPresent: missing.length === 0, missing }, scan: { complete: skipped.length === 0, entriesVisited, excludedDirectories: excluded, skipped }, findings, ...(log ? { log } : {}) };
}
