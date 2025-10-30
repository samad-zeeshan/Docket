/**
 * Minimal structured logger. Phase 4 swaps the internals for Lambda Powertools,
 * so handlers keep calling the same three methods and gain correlation ids and
 * metrics without a rewrite.
 */
type Fields = Record<string, unknown>;

function emit(level: string, message: string, fields?: Fields): void {
  process.stdout.write(JSON.stringify({ level, message, ...fields }) + '\n');
}

export const log = {
  info: (message: string, fields?: Fields) => emit('INFO', message, fields),
  warn: (message: string, fields?: Fields) => emit('WARN', message, fields),
  error: (message: string, fields?: Fields) => emit('ERROR', message, fields),
};
