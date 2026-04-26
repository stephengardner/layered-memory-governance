/**
 * Canon suggestions service: reads agent-observed L1 atoms whose
 * metadata.kind is `canon-proposal-suggestion`. Read-only from the
 * console — triage (promote/dismiss/defer) goes through the CLI
 * `scripts/canon-suggest-triage.mjs` per inv-l3-requires-human and
 * the apps/console v1 read-only scope boundary.
 *
 * The frontend exposes the suggestion shape as a structured type so
 * the view doesn't reach into untyped metadata.
 */

import { transport } from './transport';
import type { CanonAtom } from './canon.service';

export type CanonSuggestionType = 'directive' | 'preference' | 'reference';
export type CanonSuggestionReviewState =
  | 'pending'
  | 'promoted'
  | 'dismissed'
  | 'deferred';

/*
 * Authoritative union vocabularies. The runtime type guard checks
 * membership against these so a downstream renderer (e.g.
 * `meta.confidence.toFixed(2)`, `data-type={meta.suggested_type}`)
 * never receives a value the strict TS interface promised but the
 * raw atom didn't carry. Mirrored on the lib side at
 * `scripts/lib/canon-suggestion.mjs::CANON_SUGGESTION_VALID_TYPES`.
 */
const VALID_SUGGESTED_TYPES: ReadonlyArray<CanonSuggestionType> = [
  'directive',
  'preference',
  'reference',
];
const VALID_REVIEW_STATES: ReadonlyArray<CanonSuggestionReviewState> = [
  'pending',
  'promoted',
  'dismissed',
  'deferred',
];

/**
 * Strict view of the metadata fields the canon-scout writes. Anything
 * outside this shape is ignored by the view; the underlying atom may
 * carry additional fields without breaking the renderer.
 */
export interface CanonSuggestionMeta {
  readonly kind: 'canon-proposal-suggestion';
  readonly suggested_id: string;
  readonly suggested_type: CanonSuggestionType;
  readonly proposed_content: string;
  readonly chat_excerpt: string;
  readonly confidence: number;
  readonly review_state: CanonSuggestionReviewState;
  readonly review_state_changed_at?: string;
  readonly review_state_changed_by?: string;
  readonly review_reason?: string;
  readonly derived_canon_id?: string;
}

export interface CanonSuggestion extends CanonAtom {
  readonly metadata: CanonSuggestionMeta & Record<string, unknown>;
}

/**
 * Type guard with all the metadata.kind + suggested_type checks the
 * server already enforces at the route layer. Keeps the view from
 * trusting raw atom shape.
 */
export function isCanonSuggestion(atom: CanonAtom): atom is CanonSuggestion {
  if (atom.type !== 'observation') return false;
  const meta = atom.metadata as Record<string, unknown> | undefined;
  if (!meta || meta['kind'] !== 'canon-proposal-suggestion') return false;
  if (typeof meta['suggested_id'] !== 'string') return false;
  if (typeof meta['proposed_content'] !== 'string') return false;
  if (typeof meta['chat_excerpt'] !== 'string') return false;
  // Confidence is rendered via `.toFixed(2)` downstream; a non-numeric
  // value (or NaN from a malformed write) would throw TypeError. The
  // strict TS interface promises `confidence: number` but the raw atom
  // metadata is `Record<string, unknown>`; this is the runtime gate.
  if (typeof meta['confidence'] !== 'number' || Number.isNaN(meta['confidence'])) return false;
  // Union-membership checks keep the narrowed type honest. `string`
  // alone would let a malformed `suggested_type: 'decision'` slip
  // through and break `data-type={meta.suggested_type}` styling logic
  // that switches on the union literals.
  if (!VALID_SUGGESTED_TYPES.includes(meta['suggested_type'] as CanonSuggestionType)) return false;
  if (!VALID_REVIEW_STATES.includes(meta['review_state'] as CanonSuggestionReviewState)) return false;
  return true;
}

export async function listCanonSuggestions(
  params?: { readonly review_state?: CanonSuggestionReviewState },
  signal?: AbortSignal,
): Promise<ReadonlyArray<CanonSuggestion>> {
  const raw = await transport.call<ReadonlyArray<CanonAtom>>(
    'canon-suggestions.list',
    params as Record<string, unknown> | undefined,
    signal ? { signal } : undefined,
  );
  // The server already filters but cast through the type guard so the
  // view never sees an atom missing a required metadata field. Drops
  // malformed records silently (rare; the scout writes through the
  // shared lib helper that validates spec shape).
  return raw.filter(isCanonSuggestion);
}

/**
 * Render the operator-facing CLI command for the requested triage
 * action. The view uses this for the copy-to-clipboard buttons; the
 * actual mutation runs in the operator's terminal, NOT the browser.
 */
export function buildTriageCommand(
  atom: CanonSuggestion,
  action: 'promote' | 'dismiss' | 'defer',
): string {
  return `node scripts/canon-suggest-triage.mjs --atom-id ${atom.id} --action ${action}`;
}
