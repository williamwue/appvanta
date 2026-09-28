import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageEvidence } from '../packages/core/src/archive.mjs';
export { stageEvidence };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = process.argv[2] ?? '.appvanta/runs';
  const destination = process.argv[3] ?? '.appvanta/ci-evidence';
  await mkdir(resolve(destination, '..'), { recursive: true });
  const result = await stageEvidence(source, destination, { allowMissing: true });
  console.log(JSON.stringify({ destination: resolve(destination), files: result.files.length, excluded: result.excluded.length }));
}
