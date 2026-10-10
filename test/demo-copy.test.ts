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

// Plain English rules for the page and the README: 25 words a sentence, no filler, no em dash or semicolon.
const MAX_WORDS = 25;
const FILLER = /\b(comprehensive|robust|seamless|cutting-edge|state-of-the-art|powerful|leverage|utilize|ensure|delve|showcase|crucial|various|numerous|simply|just|really|basically|actually)\b/i;

function sentences(text: string): string[] {
  // A bold lead like "**Ids come from content.**" ends its own sentence.
  return text.split(/(?<=[.?!]\**)\s+|\n/).map((s) => s.trim()).filter((s) => /[a-z]/i.test(s));
}

function readmeProse(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    // Tables, images, markers and paper titles are not prose. A title keeps its own words.
    .filter((l) => !/^\s*(\||!\[|<!--|- arXiv)/.test(l))
    .join('\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

// shortcut: pulls prose out of markup and JS string literals with regexes, so a sentence
// built around a complex ${...} is checked in pieces. Move to a DOM render if that hides a long one.
function pageSentences(page: string): string[] {
  let s = page.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<span class="mtag">[^<]*<\/span>/g, '');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (let i = 0; i < 4; i++) s = s.replace(/\$\{[^{}`]*\}/g, 'N');
  const attrs = [...s.matchAll(/\b(?:content|alt|aria-label|title)="([^"]*)"/g)].map((m) => m[1]!);
  s = s.replace(/<\/?(?:b|u|i|strong|small|span)\b[^>]*>/g, '').replace(/<[^>]+>/g, '\n');
  const runs = [...s.matchAll(/[A-Za-z][^.?!\n<>`'"{}()=|\\]*(?:[.?!]|(?=[\n<`'"]))/g)].map((m) => m[0].trim());
  // Runs under three words are nearly all code, like "Math." or "let xS, yS;".
  return [...attrs.flatMap(sentences), ...runs].filter((r) => r.split(/\s+/).length >= 3);
}

function checkProse(list: string[], where: string) {
  expect(list.length, where).toBeGreaterThan(20);
  for (const s of list) {
    expect(s.split(/\s+/).filter(Boolean).length, `${where}: ${s}`).toBeLessThanOrEqual(MAX_WORDS);
    expect(s, where).not.toMatch(FILLER);
    // A prose semicolon is followed by a word. Code ends a statement with one.
    expect(s, where).not.toMatch(/—|&mdash;|;\s+[a-z]/);
  }
}

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

  it('keeps page sentences short, plain and free of filler', () => {
    const attribution = JSON.parse(readFileSync(path.join(__dirname, '..', 'demo', 'v2', 'examples.json'), 'utf8')).attribution;
    checkProse([...pageSentences(html), ...sentences(attribution)], 'page');
  });

  it('keeps README sentences short, plain and free of filler', () => {
    checkProse(sentences(readmeProse(readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8'))), 'README');
  });

  it('exposes the steps a recording drives', () => {
    expect(html).toContain('data-demo="threshold"');
    expect(html).toContain('data-demo="${d.kind}"');
    expect(html).toContain('b.dataset.demo = s.key');
    for (const key of ['hard', 'pair']) expect(html).toContain(`key: '${key}'`);
  });
});
