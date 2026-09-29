import type { PNG } from 'pngjs';

export function luminanceSsim(baseline: PNG, current: PNG, dx: number, dy: number, ignored: (x: number, y: number) => boolean) {
  const { width, height } = baseline;
  if (width < 11 || height < 11) throw new Error('SSIM requires images at least 11 by 11 pixels');
  const kernel = Array.from({ length: 11 }, (_, i) => Math.exp(-((i - 5) ** 2) / (2 * 1.5 ** 2)));
  const weight = kernel.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < 11; i++) kernel[i] = kernel[i]! / weight;
  const columns = width - 10;
  const rows = Array.from({ length: 11 }, () => new Float64Array(columns * 6));
  const a = new Float64Array(width), b = new Float64Array(width), invalid = new Uint8Array(width);
  const luminance = (data: Buffer, offset: number) => {
    const alpha = data[offset + 3]! / 255;
    return (0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!) * alpha + 255 * (1 - alpha);
  };
  let total = 0, windows = 0, excludedWindows = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cx = x + dx, cy = y + dy;
      invalid[x] = ignored(x, y) || cx < 0 || cx >= width || cy < 0 || cy >= height ? 1 : 0;
      a[x] = luminance(baseline.data, (y * width + x) * 4);
      b[x] = invalid[x] ? 0 : luminance(current.data, (cy * width + cx) * 4);
    }
    const row = rows[y % 11]!; row.fill(0);
    for (let x = 0; x < columns; x++) {
      const offset = x * 6;
      let ma = 0, mb = 0, aa = 0, bb = 0, ab = 0, bad = 0;
      for (let k = 0; k < 11; k++) {
        const av = a[x + k]!, bv = b[x + k]!, w = kernel[k]!;
        ma += w * av; mb += w * bv;
        aa += w * av * av; bb += w * bv * bv; ab += w * av * bv; bad += invalid[x + k]!;
      }
      row.set([ma, mb, aa, bb, ab, bad], offset);
    }
    if (y < 10) continue;
    for (let x = 0; x < columns; x++) {
      let ma = 0, mb = 0, aa = 0, bb = 0, ab = 0, bad = 0;
      const offset = x * 6;
      for (let k = 0; k < 11; k++) {
        const r = rows[(y - 10 + k) % 11]!, w = kernel[k]!;
        ma += w * r[offset]!; mb += w * r[offset + 1]!;
        aa += w * r[offset + 2]!; bb += w * r[offset + 3]!; ab += w * r[offset + 4]!; bad += r[offset + 5]!;
      }
      if (bad) { excludedWindows++; continue; }
      const va = Math.max(0, aa - ma * ma), vb = Math.max(0, bb - mb * mb), covariance = ab - ma * mb;
      const score = ((2 * ma * mb + 6.5025) * (2 * covariance + 58.5225)) / ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225));
      total += Math.max(-1, Math.min(1, score)); windows++;
    }
  }
  if (!windows) throw new Error('No valid SSIM windows remain after masking or alignment');
  return { method: 'luminance-gaussian11-sigma1.5' as const, score: Math.max(-1, Math.min(1, total / windows)), windows, excludedWindows, alphaBackground: 'white' as const };
}
