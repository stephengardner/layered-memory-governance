/**
 * Shared test-helpers for per-actor resume-strategy descriptor tests.
 *
 * `mkBaseAtom` was copy-pasted verbatim across
 * `cto-actor-strategy.test.ts` and `code-author-strategy.test.ts`.
 * Extracted here at N=2 per `dev-extract-helpers-at-n-2` so a third
 * actor test (e.g. an upcoming `auditor-strategy.test.ts`) imports the
 * skeleton rather than copy-pasting it again.
 *
 * The skeleton mirrors the shape used in `walk-author-sessions.test.ts`;
 * that file pre-dates the per-actor descriptor split and remains
 * pinned to its own local copy by design (it tests a sibling walk
 * mechanism with subtly different invariants). Per-actor descriptor
 * tests share this file.
 */

import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../../../src/substrate/types.js';

/**
 * Build a generic atom-skeleton with the canonical defaults
 * (schema_version=1, layer=L0, agent-observed provenance, taint=clean,
 * empty signal arrays). Specific test factories layer the
 * agent-session metadata + per-actor namespaced fields on top of this
 * shape.
 */
export function mkBaseAtom(
  id: string,
  type: Atom['type'],
  createdAt: Time,
  principalId: PrincipalId,
  metadata: Record<string, unknown>,
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: id,
    type,
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: String(principalId) },
      derived_from: [],
    },
    confidence: 1,
    created_at: createdAt,
    last_reinforced_at: createdAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: principalId,
    taint: 'clean',
    metadata,
  };
}
