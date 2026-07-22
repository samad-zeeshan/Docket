/**
 * Map SROIE and CORD labels onto Docket's receipt schema.
 *
 * Each mapper also returns the fields it actually labelled, so scoring never counts a field the dataset does not annotate.
 */
import { createHash } from 'node:crypto';
import type { LineItem, Receipt } from '../../src/lib/schema';

export type LabelField = 'merchant' | 'date' | 'total' | 'subtotal' | 'tax' | 'lineItems';
export type Split = 'fit' | 'val' | 'test';

export interface MappedLabel {
  label: Partial<Receipt>;
  fields: LabelField[];
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | undefined {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC rolls 31 Feb over to 3 March, so check the parts survived.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// SROIE receipts are Malaysian, so a numeric date is day first. Anything this
// cannot read comes back undefined and the date is left unscored for that receipt.
export function parseSroieDate(raw: string): string | undefined {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/^(\d{1,2})[\s-]*([A-Za-z]{3})[A-Za-z]*[\s-,]*(\d{2,4})$/);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? iso(Number(m[3]), month, Number(m[1])) : undefined;
  }
  return undefined;
}

// CORD prints rupiah with either a comma or a dot between thousands, and SROIE
// prints ringgit with two decimals. A final group of one or two digits is cents,
// a final group of three is thousands.
export function parseAmount(raw: string): number | undefined {
  const s = raw.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return undefined;
  const cents = s.match(/^(.*?)[.,](\d{1,2})$/);
  const whole = (cents ? cents[1]! : s).replace(/[.,]/g, '');
  const value = Number(`${whole || '0'}${cents ? `.${cents[2]}` : ''}`);
  return Number.isFinite(value) ? value : undefined;
}

export interface SroieEntities {
  company: string;
  date: string;
  address: string;
  total: string;
}

export function mapSroie(e: SroieEntities): MappedLabel {
  const label: Partial<Receipt> = {};
  const fields: LabelField[] = [];
  if (e.company?.trim()) {
    label.merchant = e.company.trim();
    fields.push('merchant');
  }
  const date = e.date ? parseSroieDate(e.date) : undefined;
  if (date) {
    label.date = date;
    fields.push('date');
  }
  const total = e.total ? parseAmount(e.total) : undefined;
  if (total !== undefined) {
    label.total = total;
    fields.push('total');
  }
  return { label, fields };
}

type CordValue = string | string[] | undefined;
interface CordMenu {
  nm?: CordValue;
  cnt?: CordValue;
  price?: CordValue;
}
export interface CordParse {
  menu?: CordMenu | CordMenu[];
  sub_total?: { subtotal_price?: CordValue; tax_price?: CordValue } & Record<string, unknown>;
  total?: { total_price?: CordValue } & Record<string, unknown>;
}

// Annotators sometimes recorded two values for one key. There is no way to know
// which the receipt means, so such a field is left out rather than picked.
function single(v: CordValue): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function cordLines(menu: CordParse['menu']): LineItem[] | undefined {
  if (!menu) return undefined;
  const lines: LineItem[] = [];
  for (const item of Array.isArray(menu) ? menu : [menu]) {
    const nm = single(item.nm);
    const price = single(item.price);
    const amount = price !== undefined ? parseAmount(price) : undefined;
    if (!nm || amount === undefined) return undefined;
    const cnt = single(item.cnt);
    const quantity = cnt ? Number(cnt.replace(/[^\d.]/g, '')) || 1 : 1;
    lines.push({ description: nm.trim(), quantity, amount });
  }
  return lines.length > 0 ? lines : undefined;
}

// CORD annotates every subtotal and tax a receipt prints, so a missing key means
// the receipt has none. That is why those two stay labelled when absent.
export function mapCord(p: CordParse): MappedLabel {
  const label: Partial<Receipt> = {};
  const fields: LabelField[] = [];
  const lines = cordLines(p.menu);
  if (lines) {
    label.lineItems = lines;
    fields.push('lineItems');
  }
  for (const [field, raw] of [
    ['subtotal', p.sub_total?.subtotal_price],
    ['tax', p.sub_total?.tax_price],
  ] as const) {
    if (raw === undefined) {
      fields.push(field);
      continue;
    }
    const value = single(raw) !== undefined ? parseAmount(single(raw)!) : undefined;
    if (value !== undefined) {
      label[field] = value;
      fields.push(field);
    }
  }
  const totalRaw = single(p.total?.total_price);
  const total = totalRaw !== undefined ? parseAmount(totalRaw) : undefined;
  if (total !== undefined) {
    label.total = total;
    fields.push('total');
  }
  return { label, fields };
}

// Split by document, never by field, so no receipt feeds both the calibration
// fit and the numbers it is judged on. Half fit, a quarter val, a quarter test.
export function splitOf(id: string): Split {
  const bucket = createHash('sha256').update(id).digest().readUInt16BE(0) % 4;
  return bucket < 2 ? 'fit' : bucket === 2 ? 'val' : 'test';
}
