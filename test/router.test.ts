import { describe, it, expect } from 'vitest';
import { routeFor, routerFeatures, type RouterParams } from '../src/lib/router';
import type { ImageStats } from '../src/lib/imagestats';

const stats: ImageStats = {
  width: 800, height: 1600, aspect: 2, megapixels: 1.28, bytesPerPixel: 0.1,
  brightness: 0.8, contrast: 0.3, sharpness: 0.02, inkDensity: 0.1, textLines: 30,
};

// Only sharpness counts: sharp enough goes to the small model.
const params: RouterParams = {
  model: 'test',
  mean: new Array(8).fill(0),
  std: new Array(8).fill(1),
  weights: [0, 1, 0, 0, 0, 0, 0, 0, 0],
  threshold: 0.5,
};

describe('routeFor', () => {
  it('sends a crisp receipt to the small model', () => {
    const r = routeFor({ ...stats, sharpness: 1000 }, params, true);
    expect(r.route).toBe('small');
    expect(r.pSmallSuffices).toBeGreaterThan(0.5);
  });

  it('sends a blurred receipt to the large model', () => {
    expect(routeFor({ ...stats, sharpness: 1e-5 }, params, true).route).toBe('large');
  });

  it('uses the large model when no small model is configured', () => {
    const r = routeFor({ ...stats, sharpness: 1000 }, params, false);
    expect(r).toMatchObject({ route: 'large', reason: 'no small model configured' });
  });

  it('uses the large model when the image could not be read', () => {
    expect(routeFor(undefined, params, true)).toMatchObject({ route: 'large', reason: 'no image statistics' });
  });

  it('uses the large model when there are no router parameters yet', () => {
    expect(routeFor(stats, undefined, true).route).toBe('large');
  });
});

describe('routerFeatures', () => {
  it('logs the heavy tailed statistics', () => {
    const f = routerFeatures(stats);
    expect(f).toHaveLength(8);
    expect(f[0]).toBeCloseTo(Math.log(0.02));
  });
});
