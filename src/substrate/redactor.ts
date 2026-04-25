/**
 * Redactor: at-write content filter for the agentic actor loop.
 *
 * Why this exists
 * ---------------
 * Agent reasoning traces, tool-call args, and tool-call results can
 * contain secrets pulled into the LLM context (operator credentials,
 * customer data, API keys). Secrets must never enter the atom store;
 * redaction happens at-write before the atom is persisted.
 *
 * Threat model
 * ------------
 * - Pattern coverage is the operator's responsibility for org-specific
 *   secrets. The default regex-based adapter covers common
 *   third-party formats (AWS keys, GH PATs, App tokens, JWT-shaped,
 *   generic high-entropy) but NOT org-specific patterns (customer
 *   IDs, internal API tokens). Encourage org override.
 * - A malicious LLM output could attempt to bypass redaction by
 *   splitting a secret across whitespace boundaries. Pattern
 *   completeness is the operator's mitigation; the framework's
 *   contribution is the seam.
 * - Redactor implementations MUST throw on internal failure rather
 *   than fall through. A crashed Redactor surfaces as a
 *   `catastrophic` failure (the agent-loop failure taxonomy) which
 *   halts the session before any unredacted content reaches the atom
 *   store. This is the opposite of most error-handling discipline;
 *   intentional for secrets.
 *
 * Contract
 * --------
 * - Pure: same input yields same output. No IO. No mutable state.
 * - Idempotent: redacting twice equals redacting once. Retry paths
 *   may pass already-redacted content; redaction MUST NOT corrupt it.
 * - Empty input returns empty string (not throw).
 *
 * Pluggability
 * ------------
 * Concrete adapters live in `examples/redactors/`. Org swaps for a
 * custom pattern set (e.g., reading patterns from canon).
 */

import type { PrincipalId } from './types.js';

export interface Redactor {
  redact(content: string, context: RedactContext): string;
}

export interface RedactContext {
  /** Where this content is flowing in the agent loop. */
  readonly kind: 'llm-input' | 'llm-output' | 'tool-args' | 'tool-result';
  /** Present for tool-args / tool-result. */
  readonly tool?: string;
  /** The principal whose session is producing this content. */
  readonly principal: PrincipalId;
}
