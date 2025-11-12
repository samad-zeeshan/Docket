/**
 * Thin logging facade over the Powertools logger. Handlers call the same three
 * methods they always did and now get structured JSON with the service name and
 * any fields, like docId, folded in for correlation.
 */
import { logger } from './powertools';

type Fields = Record<string, unknown>;

export const log = {
  info: (message: string, fields?: Fields) => logger.info(message, fields ?? {}),
  warn: (message: string, fields?: Fields) => logger.warn(message, fields ?? {}),
  error: (message: string, fields?: Fields) => logger.error(message, fields ?? {}),
};
