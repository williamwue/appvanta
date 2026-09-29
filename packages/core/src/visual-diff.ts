import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { PNG } from 'pngjs';

export interface VisualIgnoreRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface VisualDiffOptions { channelThreshold?: number; maxMismatchRatio?: number; ignoreRegions?: readonly VisualIgnoreRegion[]; maxAlignmentShift?: number }

export function parseVisualIgnoreRegions(value: unknown): VisualIgnoreRegion[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('ignoreRegions must contain at most 100 rectangles');
  return value.map(region => {
    if (!region || Object.keys(region).some(key => !['x', 'y', 'width', 'height'].includes(key))
      || ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger)
      || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1
      || [region.x, region.y, region.width, region.height].some(value => value > 100000)) throw new Error('Invalid ignore region rectangle');
    return { x: region.x, y: region.y, width: region.width, height: region.height };
  });
}

export interface VisualDiffResult {
  readonly version: 1;
  readonly status: 'passed' | 'failed';
  readonly width: number;
  readonly height: number;
  readonly comparedPixels: number;
  readonly differentPixels: number;
  readonly mismatchRatio: number;
  readonly meanChannelDifference: number;
  readonly channelThreshold: number;
  readonly maxMismatchRatio: number;
  readonly ignoredPixels?: number;
  readonly ignoreRegions?: readonly VisualIgnoreRegion[];
  readonly bounds?: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly diffPath?: string;
  readonly reason?: string;
  readonly alignment?: { readonly dx: number; readonly dy: number; readonly maxShift: number; readonly sampledPixels: number; readonly unmatchedPixels: number };
}

export async function comparePngScreenshots(baselinePath: string, currentPath: string, diffPath: string, options: VisualDiffOptions = {}): Promise<VisualDiffResult> {
  const channelThreshold = options.channelThreshold ?? 16;
  const maxMismatchRatio = options.maxMismatchRatio ?? 0;
  const maxShift = options.maxAlignmentShift ?? 0;
  if (!Number.isInteger(maxShift) || maxShift < 0 || maxShift > 16) throw new Error('maxAlignmentShift must be an integer from 0 to 16');
  if (!Number.isInteger(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) throw new Error('channelThreshold must be an integer from 0 to 255');
  if (typeof maxMismatchRatio !== 'number' || !Number.isFinite(maxMismatchRatio) || maxMismatchRatio < 0 || maxMismatchRatio > 1) throw new Error('maxMismatchRatio must be from 0 to 1');
  const ignoreRegions = parseVisualIgnoreRegions(options.ignoreRegions ?? []);
  const baseline = PNG.sync.read(await readFile(baselinePath));
  const current = PNG.sync.read(await readFile(currentPath));
  for (const region of ignoreRegions) if (region.x + region.width > baseline.width || region.y + region.height > baseline.height
    || region.x + region.width > current.width || region.y + region.height > current.height) throw new Error('Ignore region exceeds image dimensions');
  if (baseline.width !== current.width || baseline.height !== current.height) return { version: 1, status: 'failed', width: current.width, height: current.height, comparedPixels: 0, differentPixels: 0, mismatchRatio: 1, meanChannelDifference: 255, channelThreshold, maxMismatchRatio, reason: `Image dimensions differ: ${baseline.width}x${baseline.height} vs ${current.width}x${current.height}` };
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const ignored = (x: number, y: number) => ignoreRegions.some(region => x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height);
  let dx = 0, dy = 0, sampledPixels = 0, unmatchedPixels = 0;
  if (maxShift) {
    const innerWidth = baseline.width - maxShift * 2, innerHeight = baseline.height - maxShift * 2;
    if (innerWidth <= 0 || innerHeight <= 0) throw new Error('maxAlignmentShift leaves no common interior');
    const samples: number[] = [];
    const sampleCount = Math.min(4096, innerWidth * innerHeight);
    for (let sample = 0; sample < sampleCount; sample++) {
      const pixel = Math.floor(sample * innerWidth * innerHeight / sampleCount);
      const x = maxShift + pixel % innerWidth, y = maxShift + Math.floor(pixel / innerWidth);
      if (!ignored(x, y)) samples.push((y * baseline.width + x) * 4);
    }
    sampledPixels = samples.length;
    if (!sampledPixels) throw new Error('No unmasked alignment samples');
    let best = Infinity;
    for (let candidateY = -maxShift; candidateY <= maxShift; candidateY++) for (let candidateX = -maxShift; candidateX <= maxShift; candidateX++) {
      let score = 0;
      const shift = (candidateY * baseline.width + candidateX) * 4;
      for (const offset of samples) for (let channel = 0; channel < 4; channel++) score += Math.abs(baseline.data[offset + channel]! - current.data[offset + shift + channel]!);
      if (score < best || score === best && Math.abs(candidateX) + Math.abs(candidateY) < Math.abs(dx) + Math.abs(dy)) { best = score; dx = candidateX; dy = candidateY; }
    }
  }
  let differentPixels = 0, totalDifference = 0, ignoredPixels = 0;
  let left = baseline.width, top = baseline.height, right = -1, bottom = -1;
  for (let pixel = 0; pixel < baseline.width * baseline.height; pixel++) {
    const offset = pixel * 4;
    const x = pixel % baseline.width, y = Math.floor(pixel / baseline.width);
    if (ignored(x, y)) {
      ignoredPixels++;
      diff.data[offset] = 0; diff.data[offset + 1] = 128; diff.data[offset + 2] = 255; diff.data[offset + 3] = 96;
      continue;
    }
    const currentX = x + dx, currentY = y + dy;
    const unmatched = currentX < 0 || currentX >= current.width || currentY < 0 || currentY >= current.height;
    const currentOffset = (currentY * current.width + currentX) * 4;
    let maximum = 0;
    if (unmatched) unmatchedPixels++;
    for (let channel = 0; channel < 4; channel++) {
      const difference = unmatched ? 255 : Math.abs(baseline.data[offset + channel]! - current.data[currentOffset + channel]!);
      totalDifference += difference; maximum = Math.max(maximum, difference);
    }
    const changed = unmatched || maximum > channelThreshold;
    if (changed) {
      differentPixels++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      diff.data[offset] = 255; diff.data[offset + 1] = 0; diff.data[offset + 2] = 0; diff.data[offset + 3] = 255;
    } else {
      const gray = Math.round((current.data[currentOffset]! + current.data[currentOffset + 1]! + current.data[currentOffset + 2]!) / 3);
      diff.data[offset] = gray; diff.data[offset + 1] = gray; diff.data[offset + 2] = gray; diff.data[offset + 3] = 96;
    }
  }
  const comparedPixels = baseline.width * baseline.height - ignoredPixels;
  if (comparedPixels === 0) throw new Error('Ignore regions cover the entire image');
  await mkdir(dirname(diffPath), { recursive: true });
  await writeFile(diffPath, PNG.sync.write(diff));
  const mismatchRatio = differentPixels / comparedPixels;
  return { version: 1, status: mismatchRatio <= maxMismatchRatio ? 'passed' : 'failed', width: baseline.width, height: baseline.height, comparedPixels, differentPixels, mismatchRatio, meanChannelDifference: totalDifference / (comparedPixels * 4), channelThreshold, maxMismatchRatio, ...(maxShift ? { alignment: { dx, dy, maxShift, sampledPixels, unmatchedPixels } } : {}), ...(ignoreRegions.length ? { ignoredPixels, ignoreRegions: ignoreRegions.map(region => ({ ...region })) } : {}), ...(differentPixels ? { bounds: { left, top, right, bottom } } : {}), diffPath };
}
