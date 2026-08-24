/**
 * Run the small model over the public receipts and append every response to a JSONL file under .cache/runs.
 *
 * Resumable: a receipt and variant already in the file is skipped, because a full pass takes hours on one card.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { LocalProvider } from '../../src/lib/providers/local';
import { extractReceipt, extractReceiptFromImage } from '../../src/lib/extract';
import { promptSmall } from '../../src/lib/prompt';
import { LABELS, type PreparedReceipt } from './fetch';
import { allVariants, perturb } from './perturb';

export const RUNS = path.join(__dirname, '..', '..', '.cache', 'runs');
const GOLDEN = path.join(__dirname, '..', 'golden');

export interface RunLine {
  id: string;
  variant: string;
  status: 'EXTRACTED' | 'FAILED';
  text?: string;
  receipt?: unknown;
  failureReason?: string;
  repaired?: boolean;
  tokens?: [string, number][];
  inputTokens: number;
  outputTokens: number;
  seconds: number;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

// The perturbation subset is the first few test split receipts of each source in
// id order, fixed before any perturbed run. Choosing after would be cherry picking.
// It is small because the GPU is shared: four receipts at fifteen settings is 60
// calls, and every one of them is a real model run.
export function perturbationSubset(all: PreparedReceipt[], perSource = 2): PreparedReceipt[] {
  const pick = (source: string) =>
    all.filter((r) => r.source === source && r.split === 'test').sort((a, b) => a.id.localeCompare(b.id)).slice(0, perSource);
  return [...pick('sroie'), ...pick('cord')];
}

interface Job {
  id: string;
  variant: string;
  run(): ReturnType<typeof extractReceipt>;
}

async function main(): Promise<void> {
  const set = arg('set', 'main');
  const url = arg('url', process.env.LOCAL_MODEL_URL ?? 'http://localhost:1234');
  const model = arg('model', process.env.LOCAL_MODEL_ID ?? 'qwen/qwen3.5-9b');
  const constrained = set !== 'unconstrained' && set !== 'golden-unconstrained';
  // A wall clock budget, so a run on a shared GPU stops at a known time instead
  // of whenever it finishes. Jobs run in a fixed order, so the cut is not chosen.
  const budgetMs = Number(arg('max-minutes', '0')) * 60_000;
  const onlySource = arg('source', '');
  const provider = new LocalProvider(url, model, { constrained });
  const out = path.join(RUNS, `${set}.jsonl`);
  mkdirSync(RUNS, { recursive: true });
  const done = new Set(
    existsSync(out)
      ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => {
          const r = JSON.parse(l) as RunLine;
          return `${r.id}|${r.variant}`;
        })
      : [],
  );

  const jobs: Job[] = [];
  if (set.startsWith('golden')) {
    const manifest = JSON.parse(readFileSync(path.join(GOLDEN, 'manifest.json'), 'utf8')) as { id: string; text: string }[];
    for (const m of manifest) {
      const text = readFileSync(path.join(GOLDEN, m.text), 'utf8');
      jobs.push({ id: m.id, variant: 'clean', run: () => extractReceipt(provider, text, promptSmall) });
    }
  } else {
    const all = JSON.parse(readFileSync(LABELS, 'utf8')) as PreparedReceipt[];
    const receipts = (set === 'main' ? all : perturbationSubset(all, set === 'unconstrained' ? 10 : 2)).filter((r) => !onlySource || r.source === onlySource);
    const variants = set === 'perturb' ? allVariants() : ['clean'];
    for (const r of receipts) {
      for (const variant of variants) {
        jobs.push({
          id: r.id,
          variant,
          run: async () => {
            const bytes = await perturb(readFileSync(r.image), variant);
            return extractReceiptFromImage(provider, [{ mediaType: 'image/jpeg', dataBase64: bytes.toString('base64') }], promptSmall);
          },
        });
      }
    }
  }
  const todo = jobs.filter((j) => !done.has(`${j.id}|${j.variant}`));
  console.log(`${set}: ${jobs.length} jobs, ${todo.length} to run against ${model}`);

  // Four at a time matches the parallel slots LM Studio opens by default. More
  // just queues on the server and makes the per receipt timing meaningless.
  let next = 0;
  let finished = 0;
  const started = Date.now();
  async function worker(): Promise<void> {
    while (next < todo.length && (!budgetMs || Date.now() - started < budgetMs)) {
      const job = todo[next++]!;
      const t0 = Date.now();
      let line: RunLine;
      try {
        const o = await job.run();
        line = {
          id: job.id,
          variant: job.variant,
          status: o.status,
          inputTokens: o.inputTokens,
          outputTokens: o.outputTokens,
          seconds: (Date.now() - t0) / 1000,
          ...(o.status === 'EXTRACTED'
            ? {
                text: o.evidence.text,
                receipt: o.receipt,
                repaired: o.evidence.repaired,
                tokens: o.evidence.tokenLogprobs?.map((t) => [t.token, Math.round(t.logprob * 1e4) / 1e4] as [string, number]),
              }
            : { failureReason: o.failureReason }),
        };
      } catch (err) {
        console.error(`${job.id} ${job.variant}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      appendFileSync(out, JSON.stringify(line) + '\n');
      finished += 1;
      if (finished % 20 === 0) {
        const rate = (Date.now() - started) / 1000 / finished;
        console.log(`${finished}/${todo.length}  ${rate.toFixed(1)}s each  eta ${(((todo.length - finished) * rate) / 60).toFixed(0)} min`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`${set}: done, ${finished} written to ${out}`);
}

if (require.main === module) void main();
