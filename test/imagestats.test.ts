import { describe, it, expect } from 'vitest';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { imageStats } from '../src/lib/imagestats';

// A white page with dark horizontal bars, a rough stand in for lines of print.
function page(opts: { lines: number; ink?: number; paper?: number; blur?: boolean }): Buffer {
  const w = 300;
  const h = 600;
  const data = Buffer.alloc(w * h * 4);
  const pitch = Math.floor(h / (opts.lines + 1));
  for (let y = 0; y < h; y++) {
    const inLine = opts.lines > 0 && y % pitch >= pitch - 8 && y > pitch / 2;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Broken strokes, so there are edges along the line and not just at its top.
      const v = inLine && x > 20 && x < w - 20 && x % 6 < 4 ? (opts.ink ?? 20) : (opts.paper ?? 240);
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  if (opts.blur) {
    const copy = Buffer.from(data);
    for (let y = 2; y < h - 2; y++)
      for (let x = 2; x < w - 2; x++) {
        let s = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += copy[((y + dy) * w + x + dx) * 4]!;
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = Math.round(s / 25);
      }
  }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 95).data);
}

describe('imageStats', () => {
  it('reads size and aspect from the image', () => {
    const s = imageStats(page({ lines: 5 }), 'image/jpeg')!;
    expect(s.width).toBe(300);
    expect(s.height).toBe(600);
    expect(s.aspect).toBeCloseTo(2);
  });

  it('scores a blurred page as less sharp', () => {
    const crisp = imageStats(page({ lines: 10 }), 'image/jpeg')!;
    const soft = imageStats(page({ lines: 10, blur: true }), 'image/jpeg')!;
    expect(soft.sharpness).toBeLessThan(crisp.sharpness * 0.6);
  });

  it('scores a dark photo as darker and lower in contrast', () => {
    const bright = imageStats(page({ lines: 10 }), 'image/jpeg')!;
    const dark = imageStats(page({ lines: 10, ink: 5, paper: 70 }), 'image/jpeg')!;
    expect(dark.brightness).toBeLessThan(bright.brightness / 2);
    expect(dark.contrast).toBeLessThan(bright.contrast);
  });

  it('counts more lines of print on a busier receipt', () => {
    const few = imageStats(page({ lines: 4 }), 'image/jpeg')!;
    const many = imageStats(page({ lines: 20 }), 'image/jpeg')!;
    expect(few.textLines).toBeGreaterThanOrEqual(3);
    expect(few.textLines).toBeLessThanOrEqual(5);
    expect(many.textLines).toBeGreaterThan(few.textLines * 3);
    expect(many.inkDensity).toBeGreaterThan(few.inkDensity);
  });

  it('decodes a PNG as well', () => {
    const png = new PNG({ width: 10, height: 20 });
    png.data.fill(255);
    const s = imageStats(PNG.sync.write(png), 'image/png')!;
    expect(s.width).toBe(10);
    expect(s.brightness).toBeCloseTo(1);
  });

  it('returns undefined for a format it cannot decode, so the router falls back to the large model', () => {
    expect(imageStats(Buffer.from('RIFF....WEBP'), 'image/webp')).toBeUndefined();
  });
});
