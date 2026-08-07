import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { perturb, allVariants } from '../eval/public/perturb';

async function sample(): Promise<Buffer> {
  // Noise rather than a flat colour, so compression and blur have something to lose.
  const w = 200;
  const h = 300;
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 7919) % 251;
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

describe('perturb', () => {
  it('has five kinds at three levels', () => {
    expect(allVariants()).toHaveLength(15);
  });

  it('returns the clean image untouched', async () => {
    const img = await sample();
    expect(await perturb(img, 'clean')).toBe(img);
  });

  it('crops more at a higher level', async () => {
    const img = await sample();
    const m1 = await sharp(await perturb(img, 'crop-1')).metadata();
    const m3 = await sharp(await perturb(img, 'crop-3')).metadata();
    expect(m1.width!).toBeGreaterThan(m3.width!);
    expect(m3.height).toBe(300 - 2 * 30);
  });

  it('darkens and compresses', async () => {
    const img = await sample();
    const clean = await sharp(img).stats();
    const dark = await sharp(await perturb(img, 'dark-3')).stats();
    expect(dark.channels[0]!.mean).toBeLessThan(clean.channels[0]!.mean * 0.4);
    expect((await perturb(img, 'jpeg-3')).length).toBeLessThan(img.length);
  });

  it('refuses a variant it does not know', async () => {
    await expect(perturb(await sample(), 'melt-1')).rejects.toThrow('unknown variant');
  });
});
