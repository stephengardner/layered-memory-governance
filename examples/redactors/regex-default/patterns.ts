/**
 * Default regex pattern set for the reference RegexRedactor.
 *
 * Each entry: { name, pattern, replacement }. Patterns are NOT
 * exhaustive; orgs swap in their own (or compose with these).
 * Document the rationale per pattern so a reader sees why each is
 * in the set.
 *
 * Conventions
 * -----------
 * - `pattern` MUST use the global flag (`/g`) so all matches in a
 *   string get replaced, not just the first.
 * - `pattern` MUST anchor on word boundaries (`\b`) so partial
 *   matches inside larger strings still hit (e.g. "see token AKIA...
 *   in logs" should redact).
 * - `replacement` is `[REDACTED:<name>]`; the marker preserves
 *   provenance of the redaction (audits know which pattern fired);
 *   replacing with empty string would lose that signal.
 * - Replacements MUST NOT themselves match any pattern in this set
 *   (idempotence: redacting twice equals redacting once).
 */

export interface RedactionPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Claim-secret-token redaction pattern.
 *
 * Why this is in the default set
 * ------------------------------
 * Sub-agent dispatch under the zero-failure substrate hands a 43+ char
 * base64url `claim_secret_token` to the dispatched principal. That
 * token is the bearer credential for `markClaimComplete`; a leak
 * enables a sub-agent (or anyone reading a leaked agent-turn atom)
 * to forge a completion attestation. The token leak is unrecoverable
 * (the substrate cannot retroactively un-leak a credential), so
 * redaction errs toward over-stripping.
 *
 * Two arms
 * --------
 * 1. Labeled form: `claim_secret_token:\s*[A-Za-z0-9_-]{43,}` -- catches
 *    the literal preamble shape the sub-agent receives.
 * 2. Standalone form: `\b[A-Za-z0-9_-]{43,}\b` -- catches the token
 *    when an LLM paraphrases the preamble and drops the label.
 *
 * Accepted false-positive trade
 * -----------------------------
 * The standalone arm WILL also redact:
 *   - SHA-256 hex (64 hex chars matches `[A-Za-z0-9_-]{43,}`)
 *   - JWT signatures (the third base64url segment)
 *   - git commit SHAs in some encodings
 *   - any other long alphanumeric blob in the same character class
 *
 * Accepted per spec Section 11: leaked tokens are unrecoverable;
 * over-redacting a debug string is recoverable. Operators who need
 * to debug a session post-redaction can replay from the BlobStore
 * source (redaction happens at-write of the atom, not at-read of
 * the blob).
 */
export const CLAIM_SECRET_TOKEN_PATTERN: RedactionPattern = {
  name: 'claim-secret-token',
  // Single pattern with two alternatives:
  //   (?:claim_secret_token:\s*)? -- optional label prefix
  //   [A-Za-z0-9_-]{43,}         -- 43+ char base64url body
  // The label is consumed as part of the match so the replacement
  // strips both `claim_secret_token:` and the trailing token in one
  // go (rather than leaving a naked `claim_secret_token:` next to
  // a `[REDACTED:CLAIM_TOKEN]` marker, which would surface in logs).
  //
  // Alphabet-based boundaries (lookbehind/lookahead) rather than \b:
  // base64url tokens can legally start or end with `-` or `_`, neither
  // of which is a regex word character. Using \b would miss any token
  // whose edge is a non-word char, leaking it past the redactor. The
  // explicit (?<![A-Za-z0-9_-]) lookbehind asserts the previous char
  // is NOT in the alphabet; the matching lookahead asserts the same on
  // the right edge. Together they anchor the match to a maximal
  // base64url-alphabet run without depending on \b.
  pattern: /(?:claim_secret_token:\s*)?(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/g,
  replacement: '[REDACTED:CLAIM_TOKEN]',
};

export const DEFAULT_PATTERNS: ReadonlyArray<RedactionPattern> = [
  // AWS access key id format: AKIA followed by 16 uppercase alphanumeric.
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED:aws-access-key]' },
  // NOTE: AWS secret access keys are 40 chars of base64-ish, but a tight
  // regex is impossible without false positives on git SHAs (40 hex),
  // JWTs, base64-encoded blobs. A blanket /\b[A-Za-z0-9/+=]{40}\b/g
  // would redact every `git log` / `git show` line in a code-author
  // transcript, breaking debug-ability. Operators who need this should
  // ship an org-specific Redactor with context-aware matching (e.g.,
  // scan only AWS-CLI tool output, or look for `aws_secret_access_key=`
  // assignment context). Intentionally NOT included in defaults.
  // GitHub Personal Access Tokens: ghp_/ghu_/ghr_ + 36 chars.
  { name: 'github-pat', pattern: /\bgh[pur]_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED:github-pat]' },
  // GitHub App installation tokens: ghs_ + 36+ chars.
  { name: 'github-installation-token', pattern: /\bghs_[A-Za-z0-9]{36,}\b/g, replacement: '[REDACTED:github-installation-token]' },
  // GitHub OAuth tokens: gho_ + 36 chars.
  { name: 'github-oauth', pattern: /\bgho_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED:github-oauth]' },
  // JWT-shaped: three base64url segments separated by '.'.
  // Listed BEFORE claim-secret-token so JWTs get their own marker;
  // the broader standalone arm of claim-secret-token would otherwise
  // swallow each JWT segment.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[REDACTED:jwt]' },
  // Claim-secret-token: 43+ char base64url, optionally labeled. Last
  // so JWT and the github-* prefixes get specific markers first.
  CLAIM_SECRET_TOKEN_PATTERN,
];

/**
 * Apply all DEFAULT_PATTERNS to a string in order. Convenience helper
 * for call sites that want the default pattern set without
 * constructing a RegexRedactor instance (e.g., agent-turn atom
 * redaction at-write).
 *
 * Idempotent: replacements are designed not to overlap with any
 * pattern, so `redactDefault(redactDefault(s)) === redactDefault(s)`.
 *
 * @throws if input is not a string (mirrors RegexRedactor contract).
 */
export function redactDefault(input: string): string {
  if (typeof input !== 'string') {
    throw new Error(`redactDefault: expected string, got ${typeof input}`);
  }
  if (input.length === 0) return '';
  let out = input;
  for (const p of DEFAULT_PATTERNS) {
    out = out.replace(p.pattern, p.replacement);
  }
  return out;
}

/**
 * Redact claim_secret_token from an `agent-turn` atom's
 * `metadata.agent_turn.llm_input`, `metadata.agent_turn.llm_output`,
 * and `metadata.agent_turn.tool_calls`.
 *
 * Shape tolerance
 * ---------------
 * The canonical `AgentTurnMeta` shape (`src/substrate/types.ts`) uses
 * a discriminated union `{ inline: string } | { ref: BlobRef }` for
 * payload slots. The helper redacts inline payloads in place and
 * passes ref-shaped slots through unchanged (the blob is not loaded
 * here; redaction at the blob layer is a separate concern). It also
 * accepts a flat-string shape so plan-stage atoms produced by
 * stub adapters in tests redact uniformly.
 *
 * Tool-call payloads are deep-stringified, redacted, and re-parsed
 * to catch tokens nested in args/result regardless of shape.
 *
 * @param atom An object with a `metadata.agent_turn` shape; tolerated
 *   to be `unknown` and shape-checked at runtime.
 * @returns A new atom with redacted payloads. The input is not
 *   mutated.
 */
export function redactAgentTurnAtom<T>(atom: T): T {
  if (atom === null || typeof atom !== 'object') return atom;
  const a = atom as Record<string, unknown>;
  const meta = a.metadata;
  if (meta === null || typeof meta !== 'object') return atom;
  const m = meta as Record<string, unknown>;
  const turn = m.agent_turn;
  if (turn === null || typeof turn !== 'object') return atom;
  const t = turn as Record<string, unknown>;
  const redactedTurn: Record<string, unknown> = { ...t };
  if ('llm_input' in t) redactedTurn.llm_input = redactPayload(t.llm_input);
  if ('llm_output' in t) redactedTurn.llm_output = redactPayload(t.llm_output);
  if ('tool_calls' in t && Array.isArray(t.tool_calls)) {
    redactedTurn.tool_calls = t.tool_calls.map(redactToolCall);
  }
  return {
    ...a,
    metadata: { ...m, agent_turn: redactedTurn },
  } as T;
}

/**
 * Redact a payload slot. Accepts either a flat string, an
 * `{ inline: string }` discriminator (per the canonical
 * `AgentTurnMeta` shape), an `{ ref }` discriminator (passed through
 * unchanged -- redaction at the blob layer is a separate concern),
 * or an arbitrary plain object (deep-redacted via JSON round-trip
 * to catch tokens at any nesting depth without a hand-rolled walker).
 */
function redactPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactDefault(value);
  if (value === null || typeof value !== 'object') return value;
  const v = value as Record<string, unknown>;
  if (typeof v.inline === 'string') {
    return { ...v, inline: redactDefault(v.inline) };
  }
  // ref-shaped (blob pointer) -- pass through unchanged; the blob
  // itself is redacted at-write of the blob, not here.
  if ('ref' in v && typeof v.ref === 'object') return value;
  // Plain object (e.g. flat tool-call args). Deep-redact via JSON
  // round-trip so nested string properties get scanned.
  try {
    return JSON.parse(redactDefault(JSON.stringify(v)));
  } catch {
    return value;
  }
}

/**
 * Redact a single tool-call entry. Walks args/result payloads with
 * `redactPayload` (which handles inline/ref/string shapes). Other
 * fields on the tool-call are stringified-and-rewritten so any token
 * leaked in e.g. a `tool` or `name` field is also caught.
 */
function redactToolCall(call: unknown): unknown {
  if (call === null || typeof call !== 'object') return call;
  const c = call as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'args' || k === 'result') {
      out[k] = redactPayload(v);
    } else if (typeof v === 'string') {
      out[k] = redactDefault(v);
    } else if (v !== null && typeof v === 'object') {
      // Nested objects (e.g., args.{ msg: token } in older test shapes).
      // Stringify-redact-reparse catches tokens at any depth without
      // a recursive walker; structural shape is preserved by JSON
      // round-trip on plain objects.
      try {
        out[k] = JSON.parse(redactDefault(JSON.stringify(v)));
      } catch {
        // Non-JSON-able value (e.g. function, BigInt). Pass through;
        // such values should not be in an atom payload to begin with.
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}
