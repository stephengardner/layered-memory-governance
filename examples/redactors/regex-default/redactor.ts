/**
 * Reference Redactor implementation: regex-based pattern matcher.
 *
 * Indie copy/paste path:
 *   cp -r examples/redactors/regex-default <yourapp>/redactors/
 *
 * Org swap: implement your own `Redactor` (subclass or fresh)
 * covering org-specific secret patterns; compose with the default
 * pattern set for third-party formats by spreading
 * `DEFAULT_PATTERNS` into the constructor.
 *
 * Threat model
 * ------------
 * Pattern coverage is the operator's responsibility for org-specific
 * secrets. This adapter covers only the common third-party formats
 * listed in `patterns.ts`. Encourage operators to extend.
 *
 * Failure mode: throws on non-string input. The substrate-level
 * `Redactor` contract treats a thrown redactor as a `catastrophic`
 * failure; never silently fall through with unredacted content.
 */

import type { Redactor, RedactContext } from '../../../src/substrate/redactor.js';
import { DEFAULT_PATTERNS, type RedactionPattern } from './patterns.js';

export class RegexRedactor implements Redactor {
  constructor(
    private readonly patterns: ReadonlyArray<RedactionPattern> = DEFAULT_PATTERNS,
  ) {}

  redact(content: string, _context: RedactContext): string {
    if (typeof content !== 'string') {
      // Defensive: caller violated contract. Throw rather than coerce
      // to avoid silently masking a bug.
      throw new Error(`RegexRedactor: expected string, got ${typeof content}`);
    }
    if (content.length === 0) return '';
    let out = content;
    for (const p of this.patterns) {
      out = out.replace(p.pattern, p.replacement);
    }
    return out;
  }
}
