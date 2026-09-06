/**
 * Checks the static demo page still wires every recorded result it shows, and keeps its honesty lines.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { v2Data } from '../demo/v2';
import { PERTURBATIONS } from '../eval/public/perturb';

const html = readFileSync(path.join(__dirname, '..', 'demo', 'index.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>'));
const markup = html.slice(0, html.lastIndexOf('<script>'));

describe('demo page', () => {
  it('has an element for every id the script looks up', () => {
    // A renamed id fails silently in the browser, the section just stays empty.
    const ids = new Set([...script.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
    expect(ids.size).toBeGreaterThan(10);
    for (const id of ids) expect(html, `#${id}`).toContain(`id="${id}"`);
  });

  it('says it replays recorded results and never claims production use', () => {
    expect(markup).toMatch(/recorded results/i);
    expect(markup).toMatch(/no model/i);
    expect(html).not.toMatch(/runs? in production|in production use|serves customers/i);
  });

  it('keeps plain punctuation and honours reduced motion', () => {
    expect(html).not.toMatch(/[—–]/);
    expect(html).toContain('prefers-reduced-motion');
  });

  it('draws the threshold, the receipts, calibration, routing and damage from recorded files', () => {
    const d = v2Data() as any;
    expect(Object.keys(d.examples)).toEqual(expect.arrayContaining(['standard', 'hard', 'blurred', 'pair']));
    expect(d.stp.curveCalibrated.length).toBeGreaterThan(100);
    expect(d.calibration.fields.length).toBeGreaterThan(0);
    expect(d.routing.router.testN).toBeGreaterThan(0);
    expect(d.perturbation.variants.length).toBeGreaterThan(1);
  });

  it('gives the damage sliders the same levels the robustness suite used', () => {
    const d = v2Data() as any;
    expect(d.levels).toEqual(PERTURBATIONS);
    for (const kind of ['blur', 'rotate', 'dark', 'jpeg']) expect(script).toContain(`'${kind}'`);
  });
});
