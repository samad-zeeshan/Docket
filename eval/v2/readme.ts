/**
 * Render the README result tables from eval/results, and write them between their markers.
 *
 * The drift test renders the same tables and compares, so a number in the README cannot disagree with its results file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (f: string) => JSON.parse(readFileSync(path.join(ROOT, 'eval', 'results', f), 'utf8'));

const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const n3 = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : x.toFixed(3));
const usd = (x: number) => `$${x.toFixed(2)}`;
const LABEL: Record<string, string> = { lineItems: 'line items', paymentMethod: 'payment' };
const lab = (f: string) => LABEL[f] ?? f;

function table(head: string[], rows: (string | number)[][]): string {
  const align = head.map((_, i) => (i === 0 ? '---' : '---:'));
  return [head, align, ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

export function renderData(): string {
  const c = read('calibration.json');
  const s = read('stp.json');
  return table(
    ['Set', 'Receipts', 'Fields scored', 'Licence'],
    [
      ['SROIE (Malaysia, scans)', c.receipts.sroie, 'merchant, date, total', 'CC BY 4.0 per the mirror'],
      ['CORD v2 (Indonesia, photos)', c.receipts.cord, 'line items, subtotal, tax, total', 'CC BY 4.0'],
      ['Test split used for every number below', s.split.test, '', ''],
    ],
  );
}

export function renderStp(): string {
  const s = read('stp.json');
  const rows = s.operating.map((o: any, i: number) => {
    const l = s.ladder[i];
    return [
      pct(o.alpha),
      o.threshold === null ? 'none' : o.threshold.toFixed(2),
      o.test ? pct(o.test.stpRate) : '0.0%',
      o.test ? pct(o.test.fieldErrorRate) : 'n/a',
      o.verbalizedBaseline.test ? pct(o.verbalizedBaseline.test.stpRate) : '0.0%',
      l.reached ?? 'none',
    ];
  });
  return table(['Field error budget', 'Threshold (from val)', 'Straight through (test)', 'Field error (test)', 'Same rule on stated confidence', 'Highest ladder rung held'], rows);
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
  const paths = table(
    ['Path', 'Receipts', 'Valid first try', 'Valid after repair', 'Field accuracy'],
    [
      ['Claude Haiku 4.5, hand checked text', p.claudeHaikuRecorded.n, pct(p.claudeHaikuRecorded.schemaValidFirstTry), pct(p.claudeHaikuRecorded.schemaValidAfterRepair), n3(p.claudeHaikuRecorded.overall)],
      ['Qwen 3.5 9B with grammar, hand checked text', p.smallConstrained.n, pct(p.smallConstrained.schemaValidFirstTry), pct(p.smallConstrained.schemaValidAfterRepair), n3(p.smallConstrained.overall)],
      ['Qwen 3.5 9B without grammar, hand checked text', p.smallUnconstrained.n, pct(p.smallUnconstrained.schemaValidFirstTry), pct(p.smallUnconstrained.schemaValidAfterRepair), n3(p.smallUnconstrained.overall)],
      ['Qwen 3.5 9B with grammar, public photos', c.n, pct(c.constrained.schemaValidFirstTry), pct(c.constrained.schemaValidAfterRepair), n3(c.constrained.contentAccuracy)],
      ['Qwen 3.5 9B without grammar, public photos', c.n, pct(c.unconstrained.schemaValidFirstTry), pct(c.unconstrained.schemaValidAfterRepair), n3(c.unconstrained.contentAccuracy)],
    ],
  );
  const router = table(
    ['Router, test split', 'Value'],
    [
      ['Receipts where the small model got every field right', pct(r.router.smallSufficesRate)],
      ['Router accuracy at predicting that', pct(r.router.accuracy)],
      ['Router AUROC', n3(r.router.auroc)],
      ['Share sent to the small model', pct(r.router.routedSmallShare)],
      ['Field error, routed small / routed to Claude', `${pct(r.router.fieldErrorRoutedSmall)} / ${pct(r.router.fieldErrorRoutedLarge)}`],
      ['Claude on every photo, per 1,000 (estimate)', usd(r.cost.claudeEstimatePer1k)],
      ['With the router, per 1,000 (estimate)', usd(r.cost.routedEstimatePer1k)],
      ['Small model tokens per receipt, in / out (measured)', `${r.cost.smallAvgInputTokens} / ${r.cost.smallAvgOutputTokens}`],
    ],
  );
  return `${paths}\n\n${router}`;
}

export function renderRobustness(): string {
  const p = read('perturbation.json');
  const by = Object.fromEntries(p.variants.map((v: any) => [v.variant, v]));
  const kinds: [string, string][] = [['blur', 'Blur'], ['rotate', 'Rotation'], ['crop', 'Crop'], ['dark', 'Darker'], ['jpeg', 'JPEG compression']];
  const rows = kinds.map(([k, name]) => [name, n3(by.clean.fieldAccuracy), ...[1, 2, 3].map((l) => n3(by[`${k}-${l}`]?.fieldAccuracy)), pct(by[`${k}-3`]?.stp?.stpRate)]);
  const h = p.homogeneity;
  const hom = `Near identical receipts: ${h.idsDistinct} of ${h.pairs} same-merchant SROIE pairs got distinct document ids, and ${h.pairsWithSwaps} pairs had a date or total from the other receipt turn up.`;
  return `${table(['Damage', 'Clean', 'Level 1', 'Level 2', 'Level 3', 'Straight through at level 3'], rows)}\n\n${hom}`;
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
  console.log('README tables regenerated from eval/results');
}
