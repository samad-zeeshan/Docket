/**
 * Download SROIE and CORD, check every file against its pinned sha256, and prepare images and labels under .cache.
 *
 * Nothing from either set is committed. eval/public/manifest.json keeps ids, splits, labelled fields and a hash of each source image.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parquetReadObjects } from 'hyparquet';
import sharp from 'sharp';
import { SOURCES, type Source, type SourceFile } from './sources';
import { mapCord, mapSroie, splitOf, type CordParse, type MappedLabel, type Split } from './map';

export const CACHE = path.join(__dirname, '..', '..', '.cache', 'datasets');
export const IMAGES = path.join(CACHE, 'images');
export const LABELS = path.join(CACHE, 'labels.json');
export const MANIFEST = path.join(__dirname, 'manifest.json');

// Long side in pixels. Big enough that a 9B vision model still reads the small
// print, small enough that one receipt stays near a thousand image tokens.
const MAX_SIDE = 1280;

export interface PreparedReceipt extends MappedLabel {
  id: string;
  source: Source['id'];
  currency: string;
  origSplit: string;
  split: Split;
  image: string;
  sourceSha256: string;
  width: number;
  height: number;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function ensureFile(f: SourceFile): Promise<string> {
  const dest = path.join(CACHE, 'raw', f.name);
  mkdirSync(path.dirname(dest), { recursive: true });
  if (existsSync(dest) && (await sha256File(dest)) === f.sha256) return dest;
  console.log(`downloading ${f.name}`);
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  const got = await sha256File(dest);
  // A truncated download is the common failure here, and it parses fine up to
  // the missing rows. The hash is what catches it.
  if (got !== f.sha256) throw new Error(`${f.name}: sha256 ${got} does not match pinned ${f.sha256}`);
  return dest;
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function toBytes(v: unknown): Buffer {
  if (v instanceof Uint8Array) return Buffer.from(v);
  throw new Error('image column is not binary');
}

async function prepare(source: Source, f: SourceFile, file: string): Promise<PreparedReceipt[]> {
  const columns = source.id === 'sroie' ? ['image', 'key', 'entities'] : ['image', 'ground_truth'];
  // utf8: false keeps the image column as bytes. The default decodes it as text
  // and silently corrupts every PNG.
  const rows = await parquetReadObjects({ file: toArrayBuffer(readFileSync(file)), columns, utf8: false });
  const out: PreparedReceipt[] = [];
  for (const [i, row] of rows.entries()) {
    const text = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v ?? ''));
    let id: string;
    let mapped: MappedLabel;
    if (source.id === 'sroie') {
      id = `sroie-${text(row.key)}`;
      const e = row.entities as Record<string, unknown>;
      mapped = mapSroie({ company: text(e.company), date: text(e.date), address: text(e.address), total: text(e.total) });
    } else {
      const gt = JSON.parse(text(row.ground_truth)) as { gt_parse: CordParse; meta: { image_id: number } };
      id = `cord-${f.split}-${gt.meta?.image_id ?? i}`;
      mapped = mapCord(gt.gt_parse);
    }
    const raw = toBytes((row.image as { bytes: unknown }).bytes);
    const image = path.join(IMAGES, `${id}.jpg`);
    const info = await sharp(raw)
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toFile(image);
    out.push({
      id,
      source: source.id,
      currency: source.currency,
      origSplit: f.split,
      split: splitOf(id),
      image,
      sourceSha256: createHash('sha256').update(raw).digest('hex'),
      width: info.width,
      height: info.height,
      ...mapped,
    });
  }
  return out;
}

export async function main(): Promise<void> {
  mkdirSync(IMAGES, { recursive: true });
  const all: PreparedReceipt[] = [];
  for (const source of SOURCES) {
    for (const f of source.files) {
      const file = await ensureFile(f);
      const prepared = await prepare(source, f, file);
      console.log(`${f.name}: ${prepared.length} receipts`);
      all.push(...prepared);
    }
  }
  writeFileSync(LABELS, JSON.stringify(all, null, 1));
  const manifest = all.map(({ id, source, origSplit, split, fields, sourceSha256 }) => ({ id, source, origSplit, split, fields, sourceSha256 }));
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
  console.log(`prepared ${all.length} receipts into ${CACHE}`);
}

if (require.main === module) void main();
