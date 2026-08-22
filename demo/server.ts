/**
 * Serve the built static demo on localhost, the same files GitHub Pages serves.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, 'static');
const PORT = Number(process.env.PORT ?? 5173);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg' };

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  const file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
  // normalize then prefix check, so a ../ in the path cannot read outside static.
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`demo on http://localhost:${PORT}`));
