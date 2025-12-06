/**
 * Local demo server. Serves the demo page and runs the real extraction and
 * scoring over the golden set. Offline on the recorded provider by default, so
 * `npm run demo` needs no AWS account. Set DOCKET_PROVIDER=bedrock for live.
 *
 * The offline sample, scenario, and eval logic lives in `engine.ts`, shared with
 * the static-site build. This file adds the HTTP layer and the upload path.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { createProvider } from '../src/lib/providers';
import { extractReceipt, extractReceiptFromImage } from '../src/lib/extract';
import { extractText } from '../src/lib/pdf';
import { deriveDocId } from '../src/lib/docid';
import { checkTotals } from '../src/lib/schema';
import { providerName, provider, catalog, extractOne, scenario, evalAll } from './engine';

const requestedPort = Number(process.env.PORT ?? 5173);

// Uploads need a live model. An arbitrary receipt is not in the recorded set, so
// the recorded provider would miss on it. Use whatever is configured; if the demo
// is offline but an Anthropic key is present, use it just for uploads.
const uploadLive = providerName !== 'recorded' || Boolean(process.env.ANTHROPIC_API_KEY);
const uploadProvider =
  uploadLive && providerName === 'recorded'
    ? createProvider({ ...process.env, DOCKET_PROVIDER: 'anthropic', DOCKET_RECORD: '' })
    : provider;
const uploadProviderName = uploadLive ? (providerName === 'recorded' ? 'anthropic' : providerName) : providerName;

interface AnalyzeMeta {
  source: 'pdf' | 'text' | 'image';
  filename: string;
  docId: string;
  text: string;
  provider: string;
  live: boolean;
}

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// A receipt photo. There is no on-machine text to pull, so offline this can only
// say a model is needed. Live, it runs the same schema-gated extractor as text.
async function analyzeImage(bytes: Buffer, mediaType: string, filename: string) {
  const docId = deriveDocId('docket-demo', filename, createHash('sha256').update(bytes).digest('hex'));
  if (!uploadLive) {
    return { source: 'image' as const, filename, docId, provider: providerName, live: false, status: 'NO_MODEL' as const };
  }
  const outcome = await extractReceiptFromImage(uploadProvider, [{ mediaType, dataBase64: bytes.toString('base64') }]);
  return shapeOutcome(outcome, { source: 'image', filename, docId, text: '', provider: uploadProviderName, live: true });
}

// One uploaded or pasted receipt through the same extractor the pipeline uses.
// There is no ground truth for a user's own receipt, so there is no accuracy
// score here, only the clean data, whether it cleared the gate, and whether the
// stated totals add up.
async function analyze(text: string, source: 'pdf' | 'text', filename: string, contentHash: string) {
  const docId = deriveDocId('docket-demo', filename, contentHash);

  if (!uploadLive) {
    // Offline. The recorded provider only knows the built-in samples, so this
    // succeeds only if the text happens to match one. Otherwise say so plainly
    // rather than invent fields.
    try {
      const outcome = await extractReceipt(provider, text);
      return shapeOutcome(outcome, { source, filename, docId, text, provider: providerName, live: false });
    } catch {
      return { source, filename, docId, text, provider: providerName, live: false, status: 'NO_MODEL' as const };
    }
  }

  const outcome = await extractReceipt(uploadProvider, text);
  return shapeOutcome(outcome, { source, filename, docId, text, provider: uploadProviderName, live: true });
}

function shapeOutcome(outcome: Awaited<ReturnType<typeof extractReceipt>>, meta: AnalyzeMeta) {
  const base = {
    ...meta,
    promptVersion: outcome.promptVersion,
    status: outcome.status,
    latencyMs: outcome.latencyMs,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
  };
  if (outcome.status === 'EXTRACTED') {
    return { ...base, receipt: outcome.receipt, totals: checkTotals(outcome.receipt) ?? null, failureReason: null };
  }
  return { ...base, receipt: null, totals: null, failureReason: outcome.failureReason };
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MAX_UPLOAD = 12 * 1024 * 1024;

// Binary body for an uploaded PDF or image, collected as a Buffer with a size cap
// so a large file cannot exhaust memory.
function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        reject(new Error('file too large, 12 MB max'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  try {
    if (req.method === 'GET' && url === '/') {
      // Read fresh each request so edits to index.html show on a refresh, no
      // restart, and tell the browser not to cache the page.
      const html = readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url === '/api/catalog') {
      json(res, 200, {
        provider: providerName,
        uploadReady: uploadLive,
        uploadProvider: uploadProviderName,
        receipts: catalog(),
      });
      return;
    }
    if (req.method === 'POST' && url === '/api/extract') {
      const { id } = JSON.parse((await readBody(req)) || '{}') as { id?: string };
      if (!id) return json(res, 400, { error: 'missing id' });
      return json(res, 200, await extractOne(id));
    }
    if (req.method === 'POST' && url === '/api/scenario') {
      const { kind } = JSON.parse((await readBody(req)) || '{}') as { kind?: string };
      if (!kind) return json(res, 400, { error: 'missing kind' });
      return json(res, 200, await scenario(kind));
    }
    if (req.method === 'POST' && url === '/api/analyze') {
      const ctype = (req.headers['content-type'] ?? '').split(';')[0]?.trim();
      if (ctype === 'application/pdf' || ctype === 'application/octet-stream') {
        const buf = await readBodyBuffer(req);
        if (buf.length === 0) return json(res, 400, { error: 'empty upload' });
        const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'receipt.pdf'));
        let text: string;
        try {
          text = await extractText(buf);
        } catch (e) {
          // A scanned or malformed PDF has no text to pull. Report it as a state
          // the page can render, and keep serving.
          return json(res, 200, { status: 'UNREADABLE', source: 'pdf', filename, error: e instanceof Error ? e.message : String(e) });
        }
        const hash = createHash('sha256').update(buf).digest('hex');
        return json(res, 200, await analyze(text, 'pdf', filename, hash));
      }
      if (ctype && IMAGE_CONTENT_TYPES.has(ctype)) {
        const buf = await readBodyBuffer(req);
        if (buf.length === 0) return json(res, 400, { error: 'empty upload' });
        const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'receipt.png'));
        return json(res, 200, await analyzeImage(buf, ctype, filename));
      }
      const { text } = JSON.parse((await readBody(req)) || '{}') as { text?: string };
      const clean = (text ?? '').trim();
      if (!clean) return json(res, 400, { error: 'no text provided' });
      const hash = createHash('sha256').update(clean).digest('hex');
      return json(res, 200, await analyze(clean, 'text', 'pasted.txt', hash));
    }
    if (req.method === 'GET' && url === '/api/eval') {
      return json(res, 200, await evalAll());
    }
    if (url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// A local demo should stay up even when handed an odd file. PDF parsing can
// fault from inside a worker, off the await chain, so log and keep serving
// rather than letting the process exit mid-session.
process.on('unhandledRejection', (reason) => {
  console.warn('unhandled rejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.warn('uncaught exception:', err.message);
});

let activePort = requestedPort;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && process.env.PORT === undefined) {
    activePort += 1;
    console.log(`Port ${activePort - 1} is in use, trying ${activePort}.`);
    server.listen(activePort);
    return;
  }

  throw err;
});

server.listen(activePort, () => {
  console.log(`\n  Docket demo  →  http://localhost:${activePort}   (provider: ${providerName})\n`);
});
