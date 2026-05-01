/*
 * Pure helpers for the actor-activity feature. Lives here (not inline
 * in server/index.ts) so vitest can exercise the read + group logic
 * without standing up an HTTP server or touching disk in the hot path.
 *
 * Shape decision:
 *
 *   raw atoms -> filter live (non-superseded) -> sort created_at DESC
 *     -> slice top N -> group consecutive runs by principal_id
 *
 * Why CONSECUTIVE-run grouping rather than full bucket-by-principal:
 * the operator-readable narrative is "principal X did A then B then C
 * over a 2-minute window, then principal Y took over". Bucketing by
 * principal globally would surface a useful frequency view but DESTROYS
 * the time order that makes the feed read like a control-tower log.
 * The render layer can still display "12 actors active" rollup if
 * needed; the wire shape preserves order.
 *
 * The wire shape is forward-compatible with SSE: the same Entry array
 * could be emitted as one event per atom rather than a single batch
 * payload. v2 may introduce a streaming variant; v1 is a poll.
 */

export interface ActorActivityAtom {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly content: string;
  readonly principal_id: string;
  readonly confidence: number;
  readonly created_at: string;
  readonly metadata?: Record<string, unknown>;
  readonly superseded_by?: ReadonlyArray<string>;
  readonly taint?: string;
}

export interface ActorActivityEntry {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly principal_id: string;
  readonly created_at: string;
  /**
   * Short human-readable verb for the entry (e.g. 'proposed', 'observed',
   * 'decided'). Derived from atom type so the timeline reads as a verb
   * stream rather than a type stream.
   */
  readonly verb: string;
  /**
   * One-line excerpt of the atom content (already truncated server-side
   * to keep wire payload bounded; the UI may further truncate visually).
   */
  readonly excerpt: string;
}

export interface ActorActivityGroup {
  /** Stable key per group: `${principal_id}:${first_entry_id}` so React keys never collide. */
  readonly key: string;
  readonly principal_id: string;
  readonly entries: ReadonlyArray<ActorActivityEntry>;
  /** ISO timestamp of the most recent entry in the group. */
  readonly latest_at: string;
}

export interface ActorActivityResponse {
  readonly groups: ReadonlyArray<ActorActivityGroup>;
  readonly entry_count: number;
  readonly principal_count: number;
  /** ISO timestamp of when the server computed this snapshot. */
  readonly generated_at: string;
}

/*
 * Wire-payload bound. Atoms that exceed this content length get
 * truncated server-side (with an ellipsis) so the response stays small
 * even when an actor wrote a 10kb plan body. The client renders the
 * excerpt as-is; the full atom is one click away via routeForAtomId.
 */
const EXCERPT_MAX_CHARS = 240;

/*
 * Hard ceiling on entry count regardless of caller-supplied limit.
 * Defends against a misconfigured client polling for the entire atom
 * store every 5s; any value above 500 is clamped silently.
 */
export const ACTOR_ACTIVITY_MAX_LIMIT = 500;

const VERB_BY_TYPE: Readonly<Record<string, string>> = Object.freeze({
  directive: 'declared a directive',
  decision: 'recorded a decision',
  preference: 'noted a preference',
  reference: 'cited a reference',
  observation: 'observed',
  'actor-message': 'messaged',
  'actor-message-ack': 'acknowledged a message',
  'agent-session': 'started a session',
  'agent-turn': 'took a turn',
  plan: 'drafted a plan',
  'plan-merge-settled': 'settled a merge',
  question: 'raised a question',
  'operator-action': 'acted',
  /*
   * Atom type is `operator-intent` (per AtomType union); the prior
   * `intent` key here was a typo that fell through to the default
   * 'wrote' verb for all 14 operator-intent atoms in the local store
   * as of 2026-04-27. Keep the corrected key.
   */
  'operator-intent': 'expressed intent',
  'circuit-breaker-trip': 'tripped a circuit breaker',
  'circuit-breaker-reset': 'reset a circuit breaker',
  ephemeral: 'noted ephemerally',
  /*
   * Deep planning pipeline atoms (shipped in the pipeline-substrate +
   * pipelines-view + stage-output-persistence rounds). These atoms now
   * exist in the local atom store; without explicit verbs they fell
   * through to 'wrote' and obscured the pipeline narrative in the feed.
   * Grouped here so the pipeline-* family + per-stage *-output family
   * read together when scanning the map.
   */
  pipeline: 'started a pipeline',
  'pipeline-stage-event': 'transitioned a stage',
  'pipeline-audit-finding': 'flagged an audit finding',
  'pipeline-failed': 'recorded pipeline failure',
  'pipeline-resume': 'resumed a pipeline',
  'brainstorm-output': 'brainstormed alternatives',
  'spec-output': 'drafted a spec',
  'review-report': 'reviewed pipeline output',
  'dispatch-record': 'dispatched plan',
});

function truncate(s: string, n: number): string {
  if (typeof s !== 'string' || s.length === 0) return '';
  if (s.length <= n) return s;
  return s.slice(0, Math.max(1, n - 1)).trimEnd() + '\u2026';
}

function verbFor(type: string): string {
  return VERB_BY_TYPE[type] ?? 'wrote';
}

function isLive(a: ActorActivityAtom): boolean {
  if (a.superseded_by && a.superseded_by.length > 0) return false;
  if (a.taint && a.taint !== 'clean') return false;
  return true;
}

/*
 * Pure transform: take a raw atom set + caller params and produce the
 * grouped response. No I/O, no clocks beyond the explicit `now` param.
 * `now` is injected so tests are deterministic.
 */
export function buildActorActivityResponse(
  atoms: ReadonlyArray<ActorActivityAtom>,
  params: { limit?: number; principal_id?: string; exclude_types?: ReadonlyArray<string> },
  now: Date,
): ActorActivityResponse {
  // Defensive clamp: caller may pass any number or omit; we always
  // bound between 1 and ACTOR_ACTIVITY_MAX_LIMIT.
  const requested = typeof params.limit === 'number' && Number.isFinite(params.limit)
    ? params.limit
    : 100;
  const limit = Math.max(1, Math.min(ACTOR_ACTIVITY_MAX_LIMIT, Math.floor(requested)));

  const live = atoms.filter(isLive);
  /*
   * Optional per-principal filter so a focused-principal view can pull
   * only that principal's activity. When unset, behaviour is identical
   * to the prior implementation (full live feed). The value is checked
   * for non-empty string to distinguish "no filter" from "empty filter
   * matches nothing." Applied BEFORE sort + slice so the cap counts
   * the principal's atoms, not the global atoms truncated to a window
   * that happens to omit the principal.
   */
  const principalFilter = typeof params.principal_id === 'string' && params.principal_id.length > 0
    ? params.principal_id
    : null;
  const principalFiltered = principalFilter !== null
    ? live.filter((a) => a.principal_id === principalFilter)
    : live;
  /*
   * Optional type-exclusion filter so a focused per-principal view can
   * suppress noisy sub-event types ('question' atoms are internal
   * deliberation flow that aren't meaningful in a "what did this
   * principal do" feed; clicking them dead-ends in the canon view per
   * routeForAtomId's default fallback). When unset, behaviour is
   * identical to the prior implementation. The Set lookup is O(1) per
   * atom; defensive coercion to a Set tolerates any iterable input
   * (Array on the wire) and silently ignores non-string entries via
   * typeof guard so a bad client payload can't crash the response.
   */
  const exclude = new Set(
    Array.isArray(params.exclude_types)
      ? params.exclude_types.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [],
  );
  const filtered = exclude.size > 0
    ? principalFiltered.filter((a) => !exclude.has(a.type))
    : principalFiltered;
  const sorted = [...filtered].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const sliced = sorted.slice(0, limit);

  const entries: ActorActivityEntry[] = sliced.map((a) => ({
    id: a.id,
    type: a.type,
    layer: a.layer,
    principal_id: a.principal_id,
    created_at: a.created_at,
    verb: verbFor(a.type),
    excerpt: truncate(a.content ?? '', EXCERPT_MAX_CHARS),
  }));

  // Group consecutive runs of the same principal. The order of `entries`
  // is already DESC by created_at, so a flush every time the principal
  // changes preserves the narrative "X did A,B,C; then Y took over".
  const groups: ActorActivityGroup[] = [];
  let bucket: ActorActivityEntry[] = [];
  let bucketPrincipal: string | null = null;
  const principals = new Set<string>();
  for (const e of entries) {
    principals.add(e.principal_id);
    if (bucketPrincipal === null || e.principal_id === bucketPrincipal) {
      bucket.push(e);
      bucketPrincipal = e.principal_id;
      continue;
    }
    // Principal switched; flush.
    if (bucket.length > 0 && bucketPrincipal !== null) {
      const first = bucket[0]!;
      groups.push({
        key: `${bucketPrincipal}:${first.id}`,
        principal_id: bucketPrincipal,
        entries: bucket,
        latest_at: first.created_at,
      });
    }
    bucket = [e];
    bucketPrincipal = e.principal_id;
  }
  // Final flush.
  if (bucket.length > 0 && bucketPrincipal !== null) {
    const first = bucket[0]!;
    groups.push({
      key: `${bucketPrincipal}:${first.id}`,
      principal_id: bucketPrincipal,
      entries: bucket,
      latest_at: first.created_at,
    });
  }

  return {
    groups,
    entry_count: entries.length,
    principal_count: principals.size,
    generated_at: now.toISOString(),
  };
}
