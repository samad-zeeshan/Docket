/**
 * Pre-inference router: pick the small model or Claude from image statistics alone, before any extraction call.
 */
import type { ImageStats } from './imagestats';

export type Route = 'small' | 'large';

export interface RouterParams {
  model: string;
  mean: number[];
  std: number[];
  // weights[0] is the bias, the rest line up with routerFeatures.
  weights: number[];
  threshold: number;
}

export interface RouteDecision {
  route: Route;
  pSmallSuffices?: number;
  reason: string;
}

// Sharpness, ink and size span orders of magnitude between a scanner and a phone
// in a dim cafe, so they go in as logs.
export function routerFeatures(s: ImageStats): number[] {
  return [
    Math.log(Math.max(s.sharpness, 1e-8)),
    s.brightness,
    s.contrast,
    s.inkDensity,
    Math.log1p(s.textLines),
    s.aspect,
    Math.log(Math.max(s.megapixels, 1e-6)),
    Math.log(Math.max(s.bytesPerPixel, 1e-6)),
  ];
}

export function routerScore(params: RouterParams, s: ImageStats): number {
  const z = routerFeatures(s).reduce(
    (acc, x, i) => acc + ((x - params.mean[i]!) / (params.std[i]! || 1)) * params.weights[i + 1]!,
    params.weights[0]!,
  );
  return 1 / (1 + Math.exp(-z));
}

// Every doubt resolves to the large model. A wrong call that way costs a fraction
// of a cent, a wrong call the other way costs a person's time in review.
export function routeFor(stats: ImageStats | undefined, params: RouterParams | undefined, smallAvailable: boolean): RouteDecision {
  if (!smallAvailable) return { route: 'large', reason: 'no small model configured' };
  if (!stats) return { route: 'large', reason: 'no image statistics' };
  if (!params) return { route: 'large', reason: 'no router parameters' };
  const p = routerScore(params, stats);
  return p >= params.threshold
    ? { route: 'small', pSmallSuffices: p, reason: `p ${p.toFixed(3)} at or over ${params.threshold}` }
    : { route: 'large', pSmallSuffices: p, reason: `p ${p.toFixed(3)} under ${params.threshold}` };
}
