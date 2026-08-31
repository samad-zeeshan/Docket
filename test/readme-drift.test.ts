import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocks, RENDERERS } from '../eval/v2/readme';

const readme = readFileSync('README.md', 'utf8').replace(/\r\n/g, '\n');

describe('README numbers', () => {
  it('carries every generated table', () => {
    expect(blocks(readme).map((b) => b.name).sort()).toEqual(Object.keys(RENDERERS).sort());
  });

  it.each(Object.keys(RENDERERS))('matches eval/results for the %s table', (name) => {
    const block = blocks(readme).find((b) => b.name === name);
    expect(block?.body).toBe(RENDERERS[name]!());
  });
});
