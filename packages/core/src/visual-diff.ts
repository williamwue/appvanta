import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { PNG } from 'pngjs';

export interface VisualIgnoreRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface VisualDiffOptions { channelThreshold?: number; maxMismatchRatio?: number; ignoreRegions?: readonly VisualIgnoreRegion[] }

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
}

export async function comparePngScreenshots(baselinePath: string, currentPath: string, diffPath: string, options: VisualDiffOptions = {}): Promise<VisualDiffResult> {
  const channelThreshold = options.channelThreshold ?? 16;
  const maxMismatchRatio = options.maxMismatchRatio ?? 0;
  if (!Number.isInteger(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) throw new Error('channelThreshold must be an integer from 0 to 255');
  if (typeof maxMismatchRatio !== 'number' || !Number.isFinite(maxMismatchRatio) || maxMismatchRatio < 0 || maxMismatchRatio > 1) throw new Error('maxMismatchRatio must be from 0 to 1');
  const ignoreRegions = parseVisualIgnoreRegions(options.ignoreRegions ?? []);
  const baseline = PNG.sync.read(await readFile(baselinePath));
  const current = PNG.sync.read(await readFile(currentPath));
  for (const region of ignoreRegions) if (region.x + region.width > baseline.width || region.y + region.height > baseline.height
    || region.x + region.width > current.width || region.y + region.height > current.height) throw new Error('Ignore region exceeds image dimensions');
  if (baseline.width !== current.width || baseline.height !== current.height) return { version: 1, status: 'failed', width: current.width, height: current.height, comparedPixels: 0, differentPixels: 0, mismatchRatio: 1, meanChannelDifference: 255, channelThreshold, maxMismatchRatio, reason: `Image dimensions differ: ${baseline.width}x${baseline.height} vs ${current.width}x${current.height}` };
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  let differentPixels = 0, totalDifference = 0, ignoredPixels = 0;
  let left = baseline.width, top = baseline.height, right = -1, bottom = -1;
  for (let pixel = 0; pixel < baseline.width * baseline.height; pixel++) {
    const offset = pixel * 4;
    const x = pixel % baseline.width, y = Math.floor(pixel / baseline.width);
    if (ignoreRegions.some(region => x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height)) {
      ignoredPixels++;
      diff.data[offset] = 0; diff.data[offset + 1] = 128; diff.data[offset + 2] = 255; diff.data[offset + 3] = 96;
      continue;
    }
    let maximum = 0;
    for (let channel = 0; channel < 4; channel++) {
      const difference = Math.abs(baseline.data[offset + channel]! - current.data[offset + channel]!);
      totalDifference += difference; maximum = Math.max(maximum, difference);
    }
    const changed = maximum > channelThreshold;
    if (changed) {
      differentPixels++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      diff.data[offset] = 255; diff.data[offset + 1] = 0; diff.data[offset + 2] = 0; diff.data[offset + 3] = 255;
    } else {
      const gray = Math.round((current.data[offset]! + current.data[offset + 1]! + current.data[offset + 2]!) / 3);
      diff.data[offset] = gray; diff.data[offset + 1] = gray; diff.data[offset + 2] = gray; diff.data[offset + 3] = 96;
    }
  }
  const comparedPixels = baseline.width * baseline.height - ignoredPixels;
  if (comparedPixels === 0) throw new Error('Ignore regions cover the entire image');
  await mkdir(dirname(diffPath), { recursive: true });
  await writeFile(diffPath, PNG.sync.write(diff));
  const mismatchRatio = differentPixels / comparedPixels;
  return { version: 1, status: mismatchRatio <= maxMismatchRatio ? 'passed' : 'failed', width: baseline.width, height: baseline.height, comparedPixels, differentPixels, mismatchRatio, meanChannelDifference: totalDifference / (comparedPixels * 4), channelThreshold, maxMismatchRatio, ...(ignoreRegions.length ? { ignoredPixels, ignoreRegions: ignoreRegions.map(region => ({ ...region })) } : {}), ...(differentPixels ? { bounds: { left, top, right, bottom } } : {}), diffPath };
}
