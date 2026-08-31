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
const usd = (x: number) => `$${x.toFixed(2)}`;
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
  return `${rows}\n\nThe small model read ${count(c.receipts.total)} of the ${count(all)} downloaded receipts before its time budget ran out, ${s.split.test} of them in the test split.`;
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
  const line = tight.test
    ? `At a ${pct(tight.alpha)} field error budget, ${tight.test.passed} of ${s.split.test} test receipts (${pct(tight.test.stpRate)}) pass with no person, and ${tight.test.fieldErrors} of their ${tight.test.fields} fields are wrong. Thresholds were picked on ${s.split.val} validation receipts.`
    : `No threshold met a ${pct(tight.alpha)} field error budget on the ${s.split.val} validation receipts, so nothing passes at that budget.`;
  const bySource = tight.test ? ` By set that is ${tight.bySource.sroie.passed} SROIE and ${tight.bySource.cord.passed} CORD receipts.` : '';
  const pooledPass = s.pooled.filter((o: any) => o.test).length;
  const pooled = pooledPass
    ? ` Judged on all six fields at once, as the pipeline does today, ${pooledPass} of the ${s.pooled.length} budgets can be met.`
    : ` Judged on all six fields at once, as the pipeline does today, no threshold meets any of the ${s.pooled.length} budgets, so the pipeline sends every small model receipt to a person.`;
  const head = ['Field error budget', 'Threshold (from val)', 'Straight through (test)', 'Field error (test)', 'Same rule on stated confidence', 'Highest ladder rung held'];
  return `${table(head, rows)}\n\n${line}${bySource}${pooled}`;
}

export function renderCalibration(): string {
  const c = read('calibration.json');
  return table(
    ['Field', 'Test fields', 'Right', 'ECE stated', 'ECE calibrated', 'AUROC stated', 'AUROC calibrated'],
    c.fields.map((f: any) => [lab(f.field), f.n.test, pct(f.testAccuracy), n3(f.verbalized.ece), n3(f.calibrated.ece), n3(f.verbalized.auroc), n3(f.calibrated.auroc)]),
  );
}

export function renderRouting(): string {
  const r = read('routing.json');
  const p = r.paths;
  const c = r.constrainedVsUnconstrained;
  const row = (name: string, n: number, s: any, acc: number | null) => [name, n, pct(s.schemaValidFirstTry), pct(s.schemaValidAfterRepair), n3(acc)];
  const paths = table(
    ['Path', 'Receipts', 'Valid first try', 'Valid after repair', 'Field accuracy'],
    [
      row('Claude Haiku 4.5, hand checked text', p.claudeHaikuRecorded.n, p.claudeHaikuRecorded, p.claudeHaikuRecorded.overall),
      row('Qwen 3.5 9B with grammar, hand checked text', p.smallConstrained.n, p.smallConstrained, p.smallConstrained.overall),
      row('Qwen 3.5 9B without grammar, hand checked text', p.smallUnconstrained.n, p.smallUnconstrained, p.smallUnconstrained.overall),
      row('Qwen 3.5 9B with grammar, public photos', c.n, c.constrained, c.constrained.contentAccuracy),
      row('Qwen 3.5 9B without grammar, public photos', c.n, c.unconstrained, c.unconstrained.contentAccuracy),
    ],
  );
  const fails = Math.round((1 - c.unconstrained.schemaValidAfterRepair) * c.n);
  const x = r.router;
  const router =
    `Without the grammar, ${fails} of ${c.n} photo answers never became valid JSON. ` +
    `On the test split the small model got every field right on ${pct(x.smallSufficesRate)} of receipts. ` +
    `The router predicts that with ${pct(x.accuracy)} accuracy and sends ${pct(x.routedSmallShare)} to the small model, where field error is ${pct(x.fieldErrorRoutedSmall)} against ${pct(x.fieldErrorRoutedLarge)} on the rest. ` +
    `Claude on every photo would cost an estimated ${usd(r.cost.claudeEstimatePer1k)} per 1,000 receipts, ${usd(r.cost.routedEstimatePer1k)} with the router.`;
  return `${paths}\n\n${router}`;
}

export function renderRobustness(): string {
  const p = read('perturbation.json');
  const by = Object.fromEntries(p.variants.map((v: any) => [v.variant, v]));
  const kinds: [string, string][] = [['blur', 'Blur'], ['rotate', 'Rotation'], ['crop', 'Crop'], ['dark', 'Darker'], ['jpeg', 'JPEG compression']];
  const worst = kinds.map(([k, name]) => `${name.toLowerCase()} ${n3(by[`${k}-3`]?.fieldAccuracy)}`).join(', ');
  const h = p.homogeneity;
  const text =
    `On ${p.subsetSize} receipts, field accuracy is ${n3(by.clean.fieldAccuracy)} clean and, at the worst level of each damage, ${worst}. ` +
    `Near identical receipts: of ${h.pairs} same-merchant SROIE pairs, ${h.identicalFilePairs} are the same file shipped twice and share an id as they should, and ${h.distinctFilesSharingId} different files share an id. ` +
    `Of the ${h.pairsCheckedForSwaps} pairs where both receipts were read, ${h.pairsWithSwaps} had a date or total from the other receipt turn up.`;
  return text;
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
