/**
 * Bake the demo into a static site: one index.html with the recorded results embedded, plus the example images.
 *
 * Everything comes from committed files, so the Pages build needs no model, no datasets and no AWS account.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { evalAll, providerName } from './engine';
import { v2Data } from './v2';

const DEMO = __dirname;
const OUT = path.join(DEMO, 'static');

// A literal "<" (as in </script>) and the two JS line terminators U+2028 and
// U+2029 would break an inline <script>. Built from char codes so this source
// file stays pure ASCII.
const SCRIPT_UNSAFE = new RegExp('[<' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

function forScript(json: string): string {
  return json.replace(SCRIPT_UNSAFE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

async function main(): Promise<void> {
  const data = { provider: providerName, builtStatic: true, eval: await evalAll(), v2: v2Data() };

  mkdirSync(path.join(OUT, 'v2'), { recursive: true });
  const images = path.join(DEMO, 'v2');
  if (existsSync(images)) {
    for (const f of readdirSync(images).filter((n) => n.endsWith('.jpg'))) copyFileSync(path.join(images, f), path.join(OUT, 'v2', f));
  }
  const dataJson = JSON.stringify(data);
  writeFileSync(path.join(OUT, 'data.json'), dataJson);

  const html = readFileSync(path.join(DEMO, 'index.html'), 'utf8');
  const injected = html.replace('</head>', `<script>window.__DOCKET__ = ${forScript(dataJson)};</script>\n</head>`);
  if (injected === html) throw new Error('could not inject data: no </head> in index.html');
  writeFileSync(path.join(OUT, 'index.html'), injected);

  console.log(`wrote static demo to ${OUT}: ${(dataJson.length / 1024).toFixed(0)} KB embedded`);
}

void main();
