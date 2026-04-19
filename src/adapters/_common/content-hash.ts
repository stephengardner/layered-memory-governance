import { createHash } from 'node:crypto';

/**
 * Normalized content hash for deterministic dedup.
 *
 * Normalization rules:
 *  - Lowercase.
 *  - Collapse runs of whitespace to a single space.
 *  - Strip surrounding whitespace.
 *  - Strip trailing non-semantic punctuation (. , ; : ! ?).
 *
 * These rules are chosen so "Use Postgres." matches "use postgres" but
 * neither matches "use MySQL".
 *
 * Hash: sha256 over UTF-8 bytes, first 32 hex characters.
 */
export function contentHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/, '');
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
}
