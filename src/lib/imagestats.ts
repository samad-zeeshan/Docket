/**
 * Cheap image statistics the router reads before any model call: sharpness, brightness, contrast, ink and a count of printed lines.
 *
 * Pure JS decoders, so the Lambda needs no native image library.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface ImageStats {
  width: number;
  height: number;
  aspect: number;
  megapixels: number;
  bytesPerPixel: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  inkDensity: number;
  textLines: number;
}

// Work on a copy whose long side is this many pixels. The statistics are about
// the page, not the sensor, and a 12 megapixel photo would cost a second here.
const WORK_SIDE = 400;

function decode(bytes: Buffer, mediaType: string): { width: number; height: number; data: Uint8Array } | undefined {
  try {
    if (mediaType === 'image/jpeg') return jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 1024 });
    if (mediaType === 'image/png') return PNG.sync.read(bytes);
  } catch {
    return undefined;
  }
  return undefined;
}

export function imageStats(bytes: Buffer, mediaType: string): ImageStats | undefined {
  const img = decode(bytes, mediaType);
  if (!img || img.width === 0 || img.height === 0) return undefined;
  const scale = Math.min(1, WORK_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const i = (sy * img.width + Math.min(img.width - 1, Math.floor(x / scale))) * 4;
      gray[y * w + x] = (0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!) / 255;
    }
  }

  let sum = 0;
  for (const v of gray) sum += v;
  const brightness = sum / gray.length;
  let sq = 0;
  for (const v of gray) sq += (v - brightness) ** 2;
  const contrast = Math.sqrt(sq / gray.length);

  // Variance of the Laplacian, the usual focus measure. Blur flattens edges, so
  // the second derivative loses its spread.
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const c = gray[y * w + x]!;
      const lap = gray[(y - 1) * w + x]! + gray[(y + 1) * w + x]! + gray[y * w + x - 1]! + gray[y * w + x + 1]! - 4 * c;
      lapSum += lap;
      lapSq += lap * lap;
      n++;
    }
  const sharpness = n > 0 ? lapSq / n - (lapSum / n) ** 2 : 0;

  // Ink is relative to the page, not an absolute grey level, so a dim photo of a
  // clean receipt does not read as a page covered in print.
  const inkLevel = brightness - Math.max(0.08, contrast);
  const rowInk = new Float32Array(h);
  let ink = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (gray[y * w + x]! < inkLevel) {
        rowInk[y]! += 1;
        ink++;
      }
  let textLines = 0;
  let inLine = false;
  for (let y = 0; y < h; y++) {
    const busy = rowInk[y]! / w > 0.02;
    if (busy && !inLine) textLines++;
    inLine = busy;
  }

  return {
    width: img.width,
    height: img.height,
    aspect: img.height / img.width,
    megapixels: (img.width * img.height) / 1e6,
    bytesPerPixel: bytes.length / (img.width * img.height),
    brightness,
    contrast,
    sharpness,
    inkDensity: ink / gray.length,
    textLines,
  };
}
