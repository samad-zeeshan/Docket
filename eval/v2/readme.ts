/**
 * Render the README result blocks from eval/results, and write them between their markers.
 *
 * Every number in the README lives in one of these blocks. The drift test renders them again and compares.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (f: string) => JSON.parse(readFileSync(path.join(ROOT, 'eval', 'results', f), 'utf8'));

const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const n3 = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : x.toFixed(3));
// Prose rounds to two significant figures. The tables keep the exact values.
const p2 = (x: number) => `${Number((x * 100).toPrecision(2))}%`;
const usd = (x: number) => `$${Number(x.toPrecision(2))}`;
const count = (x: number) => x.toLocaleString('en-US');
const LABEL: Record<string, string> = { lineItems: 'line items', paymentMethod: 'payment' };
const lab = (f: string) => LABEL[f] ?? f;

function table(head: string[], rows: (string | number)[][]): string {
  const align = head.map((_, i) => (i === 0 ? '---' : '---:'));
  return [head, align, ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

export function renderData(): string {
  const c = read('calibration.json');
  const s = read('stp.json');
  const all = (JSON.parse(readFileSync(path.join(ROOT, 'eval', 'public', 'manifest.json'), 'utf8')) as unknown[]).length;
  const rows = table(
    ['Set', 'Receipts read', 'Fields scored', 'Licence'],
    [
      ['SROIE (Malaysia, scans)', c.receipts.sroie, 'merchant, date, total', 'CC BY 4.0 per the mirror'],
      ['CORD v2 (Indonesia, photos)', c.receipts.cord, 'line items, subtotal, tax, total', 'CC BY 4.0'],
    ],
  );
  return `${rows}\n\nThe small model read ${count(c.receipts.total)} of the ${count(all)} downloaded receipts before its time ran out. The test set holds ${s.split.test} of these receipts.`;
}

export function renderStp(): string {
  const s = read('stp.json');
  const rows = s.operating.map((o: any, i: number) => [
    pct(o.alpha),
    o.threshold === null ? 'none' : o.threshold.toFixed(2),
    o.test ? pct(o.test.stpRate) : '0.0%',
    o.test ? pct(o.test.fieldErrorRate) : 'n/a',
    o.verbalizedBaseline.test ? pct(o.verbalizedBaseline.test.stpRate) : '0.0%',
    s.ladder[i].reached ?? 'none',
  ]);
  const tight = s.operating[0];
  const t = tight.test;
  const line = t
    ? `At the tightest target of ${p2(tight.alpha)} wrong fields, ${t.passed} of ${s.split.test} test receipts go straight through. ` +
      `That is about ${p2(t.stpRate)}${t.stpRate < 0.25 ? ', which is low' : ''}. ` +
      (t.fieldErrors === 0
        ? `None of their ${t.fields} fields is wrong, so this meets the target. `
        : `Their ${t.fields} fields hold ${t.fieldErrors} wrong fields, so this ${t.fieldErrorRate <= tight.alpha ? 'meets' : 'misses'} the target. `) +
      `The thresholds come from ${s.split.val} separate tuning receipts.`
    : `No threshold met the ${p2(tight.alpha)} target on the ${s.split.val} tuning receipts. So no receipt goes straight through at that target.`;
  const bySource = t ? ` Of the receipts that go straight through, ${tight.bySource.sroie.passed} come from SROIE and ${tight.bySource.cord.passed} from CORD.` : '';
  const pooledPass = s.pooled.filter((o: any) => o.test).length;
  const pooled = pooledPass
    ? `Docket itself checks all six fields at once. Under that rule, ${pooledPass} of the ${s.pooled.length} targets hold.`
    : `Docket itself checks all six fields at once. Under that rule, no threshold meets any of the ${s.pooled.length} targets. ` +
      'So every receipt from the small model goes to a person. This is safe, but it saves no work yet.';
  const head = ['Wrong field target', 'Threshold (tuning)', 'Straight through (test)', 'Wrong fields (test)', "Model's own confidence", 'Ladder step held'];
  return `${table(head, rows)}\n\n${line}${bySource}\n\n${pooled}`;
}

export function renderCalibration(): string {
  const c = read('calibration.json');
  return table(
    ['Field', 'Test fields', 'Correct', 'Error, own `ECE`', 'Error, calibrated', 'Ranking, own `AUROC`', 'Ranking, calibrated'],
    c.fields.map((f: any) => [lab(f.field), f.n.test, pct(f.testAccuracy), n3(f.verbalized.ece), n3(f.calibrated.ece), n3(f.verbalized.auroc), n3(f.calibrated.auroc)]),
  );
}

export function renderRouting(): string {
  const r = read('routing.json');
  const p = r.paths;
  const c = r.constrainedVsUnconstrained;
  const row = (name: string, n: number, s: any, acc: number | null) => [name, n, pct(s.schemaValidFirstTry), pct(s.schemaValidAfterRepair), n3(acc)];
  const paths = table(
    ['Model and input', 'Receipts', 'Right format, first try', 'After one repair', 'Fields correct'],
    [
      row('Claude Haiku 4.5, hand checked text', p.claudeHaikuRecorded.n, p.claudeHaikuRecorded, p.claudeHaikuRecorded.overall),
      row('Qwen 3.5 9B held to the format, hand checked text', p.smallConstrained.n, p.smallConstrained, p.smallConstrained.overall),
      row('Qwen 3.5 9B free to answer, hand checked text', p.smallUnconstrained.n, p.smallUnconstrained, p.smallUnconstrained.overall),
      row('Qwen 3.5 9B held to the format, public photos', c.n, c.constrained, c.constrained.contentAccuracy),
      row('Qwen 3.5 9B free to answer, public photos', c.n, c.unconstrained, c.unconstrained.contentAccuracy),
    ],
  );
  const fails = Math.round((1 - c.unconstrained.schemaValidAfterRepair) * c.n);
  const heldFails = Math.round((1 - c.constrained.schemaValidAfterRepair) * c.n);
  const x = r.router;
  const format =
    `When free to answer, the small model failed the format check on ${fails} of ${c.n} photos, even after one repair. ` +
    (heldFails === 0 ? 'When held to the format, it never failed.' : `When held to the format, it failed on ${heldFails}.`);
  const check =
    `On the test receipts, the small model read every field correctly on about ${p2(x.smallSufficesRate)} of receipts. ` +
    `The photo check guesses this outcome correctly for about ${p2(x.accuracy)} of receipts. ` +
    `A coin toss gets 50%, so the photo check is ${x.accuracy < 0.75 ? 'only a little better' : 'clearly better'}. ` +
    `The photo check sends about ${p2(x.routedSmallShare)} of receipts to the small model. ` +
    `On those receipts, the small model gets about ${p2(x.fieldErrorRoutedSmall)} of fields wrong. ` +
    `On the other receipts, it gets about ${p2(x.fieldErrorRoutedLarge)} wrong${x.fieldErrorRoutedSmall < x.fieldErrorRoutedLarge ? ', so the photo check keeps the hard photos away from it' : ''}.`;
  const cost =
    `If Claude reads every photo, the estimated cost is about ${usd(r.cost.claudeEstimatePer1k)} for each 1,000 receipts. ` +
    `With the photo check, the estimated cost is about ${usd(r.cost.routedEstimatePer1k)}.`;
  return `${paths}\n\n${format}\n\n${check}\n\n${cost}`;
}

export function renderRobustness(): string {
  const p = read('perturbation.json');
  const by = Object.fromEntries(p.variants.map((v: any) => [v.variant, v]));
  const kinds: [string, string][] = [['blur', 'Blur'], ['rotate', 'Tilt'], ['crop', 'Crop'], ['dark', 'Darkness'], ['jpeg', 'JPEG compression']];
  const worst = kinds.filter(([k]) => by[`${k}-3`]).map(([k, name]) => ({ name, acc: by[`${k}-3`].fieldAccuracy as number }));
  const harm = worst.reduce((a, b) => (b.acc < a.acc ? b : a));
  const h = p.homogeneity;
  // Five kinds of damage is more than a sentence should list, so they go in a list.
  const damage =
    `The damage test used ${p.subsetSize} receipts. With no damage, the small model read ${p2(by.clean.fieldAccuracy)} of fields correctly. ` +
    'At the worst level of each kind of damage, it read this share of fields correctly:\n\n' +
    worst.map((w) => `- ${w.name}: ${p2(w.acc)}`).join('\n') +
    `\n\n${harm.name} does the most harm. With only ${p.subsetSize} receipts, all of these figures are rough.`;
  const pairs =
    `Some receipts look almost the same. Of ${h.pairs} SROIE pairs from the same shop, ${h.identicalFilePairs} pairs are the same file twice. ` +
    'These pairs share an id, which is correct. ' +
    (h.distinctFilesSharingId === 0
      ? 'No two different files share an id, which is good. '
      : `Different files share an id in ${h.distinctFilesSharingId} pairs, which is a bug. `) +
    `The small model read both receipts in ${h.pairsCheckedForSwaps} pairs. ` +
    (h.pairsWithSwaps === 0
      ? 'No date or total from one receipt went into the other, which is good.'
      : `In ${h.pairsWithSwaps} of these pairs, a date or total from one receipt went into the other, which is a bug.`);
  return `${damage}\n\n${pairs}`;
}

export const RENDERERS: Record<string, () => string> = {
  data: renderData,
  stp: renderStp,
  calibration: renderCalibration,
  routing: renderRouting,
  robustness: renderRobustness,
};

const BLOCK = /<!-- results:(\w+) -->\n([\s\S]*?)\n<!-- \/results -->/g;

export function blocks(readme: string): { name: string; body: string }[] {
  return [...readme.matchAll(BLOCK)].map((m) => ({ name: m[1]!, body: m[2]! }));
}

export function fill(readme: string): string {
  return readme.replace(BLOCK, (_, name: string) => `<!-- results:${name} -->\n${RENDERERS[name]!()}\n<!-- /results -->`);
}

if (require.main === module) {
  const file = path.join(ROOT, 'README.md');
  writeFileSync(file, fill(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')));
  console.log('README blocks regenerated from eval/results');
}
