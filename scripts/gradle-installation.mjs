import { statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export function resolveGradleInstallation(explicit, env = process.env) {
  const candidates = explicit !== undefined ? [{ home: explicit, source: 'argument' }] : [
    ...(env.GRADLE_HOME ? [{ home: env.GRADLE_HOME, source: 'GRADLE_HOME' }] : []),
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map(path => ({ home: resolve(path, '..'), source: 'PATH' })),
  ];
  for (const candidate of candidates) {
    const home = resolve(candidate.home), launcher = join(home, 'lib/gradle-gradle-cli-main-8.13.jar');
    try { if (statSync(launcher).isFile()) return { home, launcher, source: candidate.source }; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error(explicit !== undefined ? 'The explicit Gradle home does not contain the Gradle 8.13 launcher' : 'Gradle 8.13 launcher not found in GRADLE_HOME or PATH');
}
