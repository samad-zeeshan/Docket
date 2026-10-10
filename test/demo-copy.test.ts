/**
 * Keeps internal names off the demo page as labels. They may only appear inside a small mono tag next to a plain one.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(path.join(__dirname, '..', 'demo', 'index.html'), 'utf8');
// Tags hold the raw value on purpose. Everything outside them is what a stranger reads first.
const outsideTags = html.replace(/<span class="mtag">[^<]*<\/span>/g, '').replace(/^\s*\/\/.*$/gm, '');

const BANNED = [
  /\bECE\b/,
  /\bAUROC\b/,
  /valid first try/i,
  /valid after repair/i,
  /cord-(?:train|dev|test)-\d/,
  /robustness suite/i,
  /validation split|test split/i,
  /field error budget/i,
  /with grammar|no grammar/i,
  /schema gate/i,
  /\brouter (?:gives|predicted|has not)/i,
];

describe('demo page copy', () => {
  it('uses no internal name as a label', () => {
    // The pipeline's own reason strings are keys in the translation table, so drop that table before checking.
    const text = outsideTags.replace(/const fixed = \{[\s\S]*?\};/, '');
    for (const word of BANNED) expect(text, String(word)).not.toMatch(word);
  });

  it('shows receipt ids and scores only as tags beside a plain form', () => {
    expect(html).toContain('<span class="mtag">ECE ');
    expect(html).toMatch(/plainId\(e\.id\)[^\n]*<span class="mtag">\$\{esc\(e\.id\)\}<\/span>/);
    expect(html).toContain('Answers in the right format, first try');
    expect(html).toContain('after one repair');
  });

  it('says the damage baseline once, above the sliders', () => {
    expect(html).toContain('id="dmgBase"');
    expect(html).not.toMatch(/Clean photos/);
  });

  it('exposes the steps a recording drives', () => {
    expect(html).toContain('data-demo="threshold"');
    expect(html).toContain('data-demo="${d.kind}"');
    expect(html).toContain('b.dataset.demo = s.key');
    for (const key of ['hard', 'pair']) expect(html).toContain(`key: '${key}'`);
  });
});
