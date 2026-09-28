import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

export interface ImageMatch { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly center: { readonly x: number; readonly y: number } }

export interface PngMatchOptions {
  readonly limit?: number;
  readonly maxChannelDelta?: number;
  readonly scalePercents?: readonly number[];
}

interface DecodedImage { readonly width: number; readonly height: number; readonly data: Buffer }

function validateOptions(options: PngMatchOptions): { limit: number; maxChannelDelta: number; scalePercents: readonly number[] } {
  const limit = options.limit ?? 101, maxChannelDelta = options.maxChannelDelta ?? 0, scalePercents = options.scalePercents ?? [100];
  if (!Number.isInteger(limit) || limit < 1 || limit > 100001) throw new Error('Template match limit must be 1 to 100001');
  if (!Number.isInteger(maxChannelDelta) || maxChannelDelta < 0 || maxChannelDelta > 255) throw new Error('Template maxChannelDelta must be 0 to 255');
  if (!Array.isArray(scalePercents) || scalePercents.length < 1 || scalePercents.length > 5 || scalePercents.some(scale => !Number.isInteger(scale) || scale < 50 || scale > 200) || new Set(scalePercents).size !== scalePercents.length) throw new Error('Template scalePercents must contain 1 to 5 unique integers from 50 to 200');
  return { limit, maxChannelDelta, scalePercents };
}

function resizeBilinear(source: DecodedImage, scalePercent: number): DecodedImage {
  if (scalePercent === 100) return source;
  const width = Math.max(1, Math.round(source.width * scalePercent / 100)), height = Math.max(1, Math.round(source.height * scalePercent / 100));
  if (width > 1024 || height > 1024) throw new Error('Scaled template dimensions must be at most 1024 pixels');
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceX = Math.max(0, Math.min(source.width - 1, (x + 0.5) * source.width / width - 0.5));
    const sourceY = Math.max(0, Math.min(source.height - 1, (y + 0.5) * source.height / height - 0.5));
    const x0 = Math.floor(sourceX), x1 = Math.min(source.width - 1, x0 + 1), y0 = Math.floor(sourceY), y1 = Math.min(source.height - 1, y0 + 1);
    const xWeight = sourceX - x0, yWeight = sourceY - y0;
    for (let channel = 0; channel < 4; channel++) {
      const top = source.data[(y0 * source.width + x0) * 4 + channel]! * (1 - xWeight) + source.data[(y0 * source.width + x1) * 4 + channel]! * xWeight;
      const bottom = source.data[(y1 * source.width + x0) * 4 + channel]! * (1 - xWeight) + source.data[(y1 * source.width + x1) * 4 + channel]! * xWeight;
      data[(y * width + x) * 4 + channel] = Math.round(top * (1 - yWeight) + bottom * yWeight);
    }
  }
  return { width, height, data };
}

function pixelWithinDelta(left: Buffer, leftOffset: number, right: Buffer, rightOffset: number, delta: number): boolean {
  return Math.abs(left[leftOffset]! - right[rightOffset]!) <= delta && Math.abs(left[leftOffset + 1]! - right[rightOffset + 1]!) <= delta && Math.abs(left[leftOffset + 2]! - right[rightOffset + 2]!) <= delta && Math.abs(left[leftOffset + 3]! - right[rightOffset + 3]!) <= delta;
}

function match(screen: DecodedImage, template: DecodedImage, x: number, y: number, maxChannelDelta: number): boolean {
  for (let row = 0; row < template.height; row++) for (let column = 0; column < template.width; column++) {
    if (!pixelWithinDelta(screen.data, ((y + row) * screen.width + x + column) * 4, template.data, (row * template.width + column) * 4, maxChannelDelta)) return false;
  }
  return true;
}

function imageMatch(x: number, y: number, template: DecodedImage): ImageMatch {
  return { left: x, top: y, right: x + template.width - 1, bottom: y + template.height - 1, center: { x: x + Math.floor(template.width / 2), y: y + Math.floor(template.height / 2) } };
}

function findDecodedMatches(screen: DecodedImage, template: DecodedImage, maxChannelDelta: number, limit: number): ImageMatch[] {
  if (template.width > screen.width || template.height > screen.height) return [];
  const matches: ImageMatch[] = [];
  if (maxChannelDelta === 0) {
    const rowBytes = template.width * 4, firstRow = template.data.subarray(0, rowBytes);
    for (let y = 0; y <= screen.height - template.height && matches.length < limit; y++) {
      const rowStart = y * screen.width * 4, lastStart = rowStart + (screen.width - template.width) * 4;
      for (let offset = screen.data.indexOf(firstRow, rowStart); offset >= 0 && offset <= lastStart && matches.length < limit; offset = screen.data.indexOf(firstRow, offset + 4)) {
        if ((offset - rowStart) % 4 !== 0) continue;
        const x = (offset - rowStart) / 4;
        if (match(screen, template, x, y, 0)) matches.push(imageMatch(x, y, template));
      }
    }
    return matches;
  }
  for (let y = 0; y <= screen.height - template.height && matches.length < limit; y++) for (let x = 0; x <= screen.width - template.width && matches.length < limit; x++) {
    const screenStart = (y * screen.width + x) * 4;
    if (!pixelWithinDelta(screen.data, screenStart, template.data, 0, maxChannelDelta)) continue;
    if (match(screen, template, x, y, maxChannelDelta)) matches.push(imageMatch(x, y, template));
  }
  return matches;
}

/** Deterministic RGBA PNG matching with optional per-channel tolerance and bounded bilinear scales. */
export async function findPngMatches(screenshotPath: string, templatePath: string, options: PngMatchOptions = {}): Promise<readonly ImageMatch[]> {
  const { limit, maxChannelDelta, scalePercents } = validateOptions(options);
  const [screen, template] = await Promise.all([readFile(screenshotPath).then(value => PNG.sync.read(value) as DecodedImage), readFile(templatePath).then(value => PNG.sync.read(value) as DecodedImage)]);
  if (template.width < 1 || template.height < 1 || template.width > 512 || template.height > 512) throw new Error('Template dimensions must be 1..512 pixels');
  const unique = new Map<string, ImageMatch>();
  for (const scalePercent of scalePercents) for (const match of findDecodedMatches(screen, resizeBilinear(template, scalePercent), maxChannelDelta, limit)) unique.set(`${match.left}:${match.top}:${match.right}:${match.bottom}`, match);
  return [...unique.values()].sort((left, right) => left.top - right.top || left.left - right.left || left.bottom - right.bottom || left.right - right.right).slice(0, limit);
}

/** Exact RGBA matching intended for screenshot-cropped templates. */
export async function findExactPngMatches(screenshotPath: string, templatePath: string, limit = 101): Promise<readonly ImageMatch[]> {
  return findPngMatches(screenshotPath, templatePath, { limit });
}
