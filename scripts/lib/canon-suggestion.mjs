// scripts/lib/canon-suggestion.mjs - pure helpers for the canon-scout
// suggestion sweep + triage CLI.
//
// substrate-not-prescription: a canon-proposal-suggestion is shaped as
// a regular L1 `observation` atom whose `metadata.kind` discriminates
// it. No new AtomType is added to the framework union; the suggestion
// is exactly an agent-observed record about the operator chat that the
// operator may later promote to L3 canon via scripts/decide.mjs.
//
// The L3 promotion path is NEVER inside this module. The agent suggests
// at L1; only scripts/decide.mjs (operator-invoked) writes L3 canon.
// This preserves inv-l3-requires-human at the substrate layer.
//
// Zero imports from src/, dist/, .lag/, fs, child_process. All callers
// thread their host + io in from the outside; this module is logic only.

const VALID_SUGGESTED_TYPES = ['directive', 'preference', 'reference'];
const VALID_REVIEW_STATES = ['pending', 'promoted', 'dismissed', 'deferred'];
const ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUGGESTION_KIND = 'canon-proposal-suggestion';

export const CANON_SUGGESTION_KIND = SUGGESTION_KIND;
export const CANON_SUGGESTION_VALID_TYPES = Object.freeze([...VALID_SUGGESTED_TYPES]);
export const CANON_SUGGESTION_VALID_STATES = Object.freeze([...VALID_REVIEW_STATES]);

/**
 * Validate a suggestion spec. Returns { ok: true, spec } or
 * { ok: false, errors: string[] }.
 */
export function validateSuggestionSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return { ok: false, errors: ['spec: required object'] };
  }
  if (typeof spec.suggested_id !== 'string' || !ID_REGEX.test(spec.suggested_id)) {
    errors.push('suggested_id: required, kebab-case (a-z, 0-9, hyphens, e.g. dev-foo-bar)');
  }
  if (!VALID_SUGGESTED_TYPES.includes(spec.suggested_type)) {
    errors.push(`suggested_type: required, one of ${VALID_SUGGESTED_TYPES.join('|')}`);
  }
  if (typeof spec.proposed_content !== 'string' || spec.proposed_content.trim().length < 20) {
    errors.push('proposed_content: required, >= 20 chars (canon-quality prose)');
  }
  if (typeof spec.chat_excerpt !== 'string' || spec.chat_excerpt.trim().length === 0) {
    errors.push('chat_excerpt: required, non-empty (the operator quote that triggered the suggestion)');
  }
  if (
    typeof spec.confidence !== 'number'
    || !Number.isFinite(spec.confidence)
    || spec.confidence < 0
    || spec.confidence > 1
  ) {
    errors.push('confidence: required number in [0, 1]');
  }
  if (typeof spec.scout_principal_id !== 'string' || spec.scout_principal_id.length === 0) {
    errors.push('scout_principal_id: required, the agent that observed the operator');
  }
  return errors.length === 0 ? { ok: true, spec } : { ok: false, errors };
}

/**
 * Build a canon-proposal-suggestion atom from a validated spec.
 *
 * Shape decisions:
 *   - type='observation' (the closest semantic fit in the AtomType
 *     union: an agent-observed L1 record about the world). The original
 *     spec proposal of `note` is not in the framework's AtomType union;
 *     surfacing the constraint here, picking the substrate-clean type
 *     that already exists, and marking the discriminator on
 *     metadata.kind keeps us within `dev-substrate-not-prescription`.
 *   - layer='L1' — never L3. L3 is only ever reached through
 *     scripts/decide.mjs (operator-invoked).
 *   - principal_id = scout (the agent that observed); the eventual L3
 *     atom (if promoted) carries the operator's principal_id via decide.
 *   - provenance.kind='agent-observed' — the suggestion is an agent's
 *     read of the operator's chat, NOT an operator assertion. The
 *     operator-asserted identity gets stamped only when decide.mjs writes
 *     the L3 atom.
 *   - confidence = the agent's self-rated confidence; arbitration
 *     source-rank already weights L1 + agent-observed below L3 +
 *     human-asserted, so this atom never beats real canon.
 *   - metadata.review_state='pending' on creation; the triage CLI
 *     transitions it.
 *
 * Caller passes `now` + `nonce` + `id_seed` in for testability.
 */
export function buildSuggestionAtom(spec, opts) {
  const validated = validateSuggestionSpec(spec);
  if (!validated.ok) {
    const err = new Error(`invalid suggestion spec: ${validated.errors.join('; ')}`);
    err.code = 'invalid-spec';
    err.errors = validated.errors;
    throw err;
  }
  const { now, nonce, idSeed } = opts ?? {};
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('buildSuggestionAtom: opts.now must be a valid Date');
  }
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new Error('buildSuggestionAtom: opts.nonce must be a non-empty string');
  }
  const seed = typeof idSeed === 'string' && idSeed.length > 0 ? idSeed : spec.suggested_id;
  const createdAt = now.toISOString();
  // Atom id: predictable prefix so the file-watcher and `routeForAtomId`
  // can recognize these without parsing metadata. Includes the suggested
  // id so duplicates per (suggestion target × nonce) are still possible
  // — operators may legitimately resuggest a refined version of an
  // existing suggestion before triaging the prior.
  const id = `canon-suggestion-${seed}-${nonce}`;
  const excerpt = spec.chat_excerpt.trim();
  // The atom's `content` is the suggestion summary (short, scannable),
  // not the full chat excerpt. The excerpt lives on metadata where the
  // UI renders it in a code-block. This keeps `content` searchable
  // without flooding it with operator chat verbatim.
  const content = `[suggestion] ${spec.suggested_type} ${spec.suggested_id}: ${spec.proposed_content.trim().slice(0, 240)}`;
  return {
    schema_version: 1,
    id,
    content,
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: spec.scout_principal_id, tool: 'canon-scout' },
      derived_from: [],
    },
    confidence: spec.confidence,
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
    principal_id: spec.scout_principal_id,
    taint: 'clean',
    metadata: {
      kind: SUGGESTION_KIND,
      suggested_id: spec.suggested_id,
      suggested_type: spec.suggested_type,
      proposed_content: spec.proposed_content.trim(),
      chat_excerpt: excerpt,
      confidence: spec.confidence,
      review_state: 'pending',
    },
  };
}

/**
 * Type guard / classifier: an atom is a canon-suggestion when it is
 * type='observation' AND metadata.kind === 'canon-proposal-suggestion'.
 * Both checks are required so a stray observation can't accidentally
 * be triaged.
 */
export function isCanonSuggestionAtom(atom) {
  if (!atom || typeof atom !== 'object') return false;
  if (atom.type !== 'observation') return false;
  const meta = atom.metadata;
  if (!meta || typeof meta !== 'object') return false;
  return meta.kind === SUGGESTION_KIND;
}

/**
 * Return only the pending suggestions from a list of atoms.
 */
export function filterPendingSuggestions(atoms) {
  return atoms.filter((a) => isCanonSuggestionAtom(a) && a.metadata.review_state === 'pending');
}

/**
 * Filter suggestions by an explicit review_state.
 */
export function filterSuggestionsByState(atoms, state) {
  if (!VALID_REVIEW_STATES.includes(state)) {
    throw new Error(`unknown review_state: ${state} (valid: ${VALID_REVIEW_STATES.join('|')})`);
  }
  return atoms.filter((a) => isCanonSuggestionAtom(a) && a.metadata.review_state === state);
}

// Triage action -> review_state mapping. The action verbs are operator-
// facing (`promote` reads naturally on the CLI); review_state is the
// machine-readable label persisted in metadata. Kept here so the CLI
// and the tests share the same vocabulary.
export const CANON_SUGGESTION_ACTIONS = Object.freeze(['promote', 'dismiss', 'defer']);
export const CANON_SUGGESTION_ACTION_TO_STATE = Object.freeze({
  promote: 'promoted',
  dismiss: 'dismissed',
  defer: 'deferred',
});

/**
 * Apply a triage action against a host's atom store. Used by both the
 * CLI (scripts/canon-suggest-triage.mjs) and the unit tests, so the
 * codepath is exercised identically. The host argument matches the
 * `Host` interface — only `host.atoms.put` is used.
 *
 * Returns `{ atom, mutated, awaitingDecide }`:
 *   - awaitingDecide=true means the caller invoked `promote` without a
 *     `derivedCanonId` yet. This is phase 1 of promote (preserves
 *     inv-l3-requires-human): no mutation is performed; the caller is
 *     expected to surface the decide.mjs invocation, the operator runs
 *     it, and the caller re-invokes with --derived-canon-id pointing at
 *     the new L3 atom. Phase 2 is the actual mutation.
 *   - awaitingDecide=false + mutated=true means the suggestion atom was
 *     updated with a new review_state.
 *
 * Throws when the input is not a canon-proposal-suggestion atom — the
 * triage CLI is hard-gated on the discriminator so it cannot
 * accidentally mutate adjacent observation atoms.
 */
export async function applyTriageAction(host, atom, opts) {
  if (!isCanonSuggestionAtom(atom)) {
    throw new Error(
      `atom ${atom?.id ?? '<unknown>'} is not a canon-proposal-suggestion `
      + `(type=${atom?.type} metadata.kind=${atom?.metadata?.kind ?? 'undefined'})`,
    );
  }
  const { action, actorId, nowIso, reason, derivedCanonId } = opts ?? {};
  if (!CANON_SUGGESTION_ACTIONS.includes(action)) {
    throw new Error(`unknown action: ${action} (valid: ${CANON_SUGGESTION_ACTIONS.join('|')})`);
  }
  const targetState = CANON_SUGGESTION_ACTION_TO_STATE[action];
  if (action === 'promote' && (!derivedCanonId || derivedCanonId.length === 0)) {
    return { atom, mutated: false, awaitingDecide: true };
  }
  const metadataPatch = buildTriagedMetadata(atom.metadata, targetState, {
    actorId,
    nowIso,
    ...(derivedCanonId ? { derivedCanonId } : {}),
    ...(reason ? { reason } : {}),
  });
  // AtomStore.update merges metadata; .put throws ConflictError on
  // an existing id. Update is the right primitive for in-place state
  // changes against an existing atom.
  const updated = await host.atoms.update(atom.id, { metadata: metadataPatch });
  return { atom: updated, mutated: true, awaitingDecide: false };
}

/**
 * Compute the next-state metadata patch when an operator triages a
 * suggestion. Returns the merged metadata object; callers persist via
 * AtomStore.update or the file adapter equivalent. Pure: no I/O.
 *
 * `nextState` is one of pending|promoted|dismissed|deferred.
 * `derivedCanonId` is the atom id of the canon written by decide.mjs;
 *   set only when nextState === 'promoted'. Required in that case so
 *   the audit trail traces back from suggestion → real canon atom.
 */
export function buildTriagedMetadata(existingMetadata, nextState, opts) {
  if (!VALID_REVIEW_STATES.includes(nextState)) {
    throw new Error(`unknown review_state: ${nextState} (valid: ${VALID_REVIEW_STATES.join('|')})`);
  }
  const { actorId, nowIso, derivedCanonId, reason } = opts ?? {};
  if (typeof actorId !== 'string' || actorId.length === 0) {
    throw new Error('buildTriagedMetadata: opts.actorId required (the operator running the CLI)');
  }
  if (typeof nowIso !== 'string' || nowIso.length === 0) {
    throw new Error('buildTriagedMetadata: opts.nowIso required (ISO-8601 timestamp)');
  }
  if (nextState === 'promoted' && (typeof derivedCanonId !== 'string' || derivedCanonId.length === 0)) {
    throw new Error('buildTriagedMetadata: derivedCanonId required when nextState=promoted');
  }
  const merged = {
    ...(existingMetadata ?? {}),
    review_state: nextState,
    review_state_changed_at: nowIso,
    review_state_changed_by: actorId,
    // State-scoped fields. Clear them by default and re-supply only
    // when the caller passes them for THIS transition. Without this:
    //   defer --reason "not now" -> dismiss (no reason)
    //     ==> stale "not now" attaches to the dismissed state.
    //   promote --derived-canon-id X -> defer
    //     ==> stale derived_canon_id X attaches to a non-promoted atom.
    // Both lie in the audit trail. Both AtomStore.update implementations
    // (memory + file) merge metadata by spreading existing first, so a
    // bare `delete` here would survive into the persisted atom; explicit
    // `null` is the patch primitive that overrides the stale value.
    derived_canon_id: null,
    review_reason: null,
  };
  if (nextState === 'promoted' && derivedCanonId) {
    merged.derived_canon_id = derivedCanonId;
  }
  if (typeof reason === 'string' && reason.length > 0) {
    merged.review_reason = reason;
  }
  return merged;
}
