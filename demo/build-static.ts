/**
 * Bake the offline demo into a static site: one index.html with the catalog, each
 * sample's extraction, the two scenarios, and the eval all embedded, so it runs
 * with no backend and no cost on any static host. Uploads are not part of the
 * static build, they need the local server and a model, so the page says so.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { catalog, extractOne, scenario, evalAll, providerName } from './engine';

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
  const receipts = catalog();
  const samples: Record<string, unknown> = {};
  for (const r of receipts) samples[r.id] = await extractOne(r.id);
  const scenarios = { rejected: await scenario('rejected'), idempotent: await scenario('idempotent') };
  const evaluation = await evalAll();

  const data = {
    provider: providerName,
    builtStatic: true,
    catalog: { provider: providerName, uploadReady: false, uploadProvider: providerName, receipts },
    samples,
    scenarios,
    eval: evaluation,
  };

  mkdirSync(OUT, { recursive: true });
  const dataJson = JSON.stringify(data);
  writeFileSync(path.join(OUT, 'data.json'), dataJson);

  const html = readFileSync(path.join(DEMO, 'index.html'), 'utf8');
  const injected = html.replace('</head>', `<script>window.__DOCKET__ = ${forScript(dataJson)};</script>\n</head>`);
  if (injected === html) throw new Error('could not inject data: no </head> in index.html');
  writeFileSync(path.join(OUT, 'index.html'), injected);

  console.log(`wrote static demo to ${OUT}: ${receipts.length} samples, ${(dataJson.length / 1024).toFixed(0)} KB embedded`);
}

void main();
