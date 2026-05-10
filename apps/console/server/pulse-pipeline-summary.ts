/**
 * Pure helper: aggregate live pipelines into the Pulse tile's
 * three-bucket summary (running / dispatched-pending-merge /
 * intent-fulfilled).
 *
 * Read the seed atom set, walk every pipeline atom that is clean +
 * live, synthesize its intent-outcome via the same `buildIntentOutcome`
 * synthesizer the `/pipelines/<id>` detail view uses, and roll the
 * synthesized state into a three-bucket count.
 *
 * Design constraints baked into this module:
 *   - Pure function, no I/O. The handler in server/index.ts feeds the
 *     full atom array in.
 *   - Read-only by construction.
 *   - Reuses `buildIntentOutcome` so the "intent-fulfilled" definition
 *     is identical to /pipelines/<id>'s detail card (TRUE-outcome
 *     semantics: a real merged PR observed, not plan_state alone).
 *   - Server-side aggregation keeps the org-ceiling case practical per
 *     canon `dev-indie-floor-org-ceiling`: 50+ concurrent actors don't
 *     push every pipeline atom to every Pulse client.
 *   - Same isCleanLive + sample-cap shape as the sibling pipelines.ts
 *     module so the two surfaces agree on what counts as "alive".
 */

import { buildIntentOutcome } from './intent-outcome.js';
import type { IntentOutcomeSourceAtom } from './intent-outcome-types.js';
import { readString } from './projection-helpers.js';
import type {
  PulsePipelineSummary,
  PulsePipelineSummaryRow,
} from './pulse-pipeline-summary-types.js';

/**
 * Hard cap on sample rows returned per bucket. The Pulse tile is small;
 * the operator clicks through to /pipelines for the full list. Five is
 * enough to convey "what's active" without scrolling.
 */
export const MAX_PULSE_SAMPLE = 5;

/**
 * Live-atom filter: matches `pipelines.ts` and `intent-outcome.ts` so a
 * tainted / superseded atom never inflates these counts. Keeping the
 * shape identical means a future canon edit that broadens / narrows
 * what "alive" means lands in one place per the sibling-module
 * convention. (When that consolidation lands, the three local copies
 * are extracted into projection-helpers per `dev-extract-at-n=2`.)
 */
function isCleanLive(atom: IntentOutcomeSourceAtom): boolean {
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Parse an ISO timestamp; return NaN on invalid input. Same shape as
 * the sibling projection modules.
 */
function parseIsoTs(value: string | undefined | null): number {
  if (typeof value !== 'string' || value.length === 0) return NaN;
  return Date.parse(value);
}

/**
 * Bucketed row pulled from one pipeline's intent-outcome synthesis.
 * The internal shape carries the parsed timestamp so we can sort by
 * recency without re-parsing per comparison.
 */
interface BucketedRow {
  readonly pipeline_id: string;
  readonly title: string;
  readonly last_event_at: string;
  readonly last_event_ts: number;
}

/**
 * Pre-index the latest stage event by pipeline_id with a single pass
 * over the atom set. The summary builder calls this once per request
 * and then resolves per-pipeline last-event in O(1) via the returned
 * Map. Earlier shape (a full-store rescan inside the per-pipeline
 * loop) was O(P x N) per request; under the Pulse poll cadence at
 * the 50-actor org ceiling, that path degrades sharply. Index-once
 * stays O(N) regardless of P. Defensive: skips malformed timestamps
 * and atoms without a pipeline_id so a single bad write does not
 * throw or skew the index.
 */
function latestStageEventByPipeline(
  atoms: ReadonlyArray<IntentOutcomeSourceAtom>,
): ReadonlyMap<string, { ts: number; iso: string }> {
  const best = new Map<string, { ts: number; iso: string }>();
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-stage-event') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const pipelineId = readString(meta, 'pipeline_id');
    if (pipelineId === null) continue;
    const ts = parseIsoTs(atom.created_at);
    if (!Number.isFinite(ts)) continue;
    const prior = best.get(pipelineId);
    if (prior === undefined || ts > prior.ts) {
      best.set(pipelineId, { ts, iso: atom.created_at });
    }
  }
  return best;
}

/**
 * Derive a `last_event_at` ISO string for a pipeline. Reads the
 * pre-indexed latest-stage-event map (see `latestStageEventByPipeline`)
 * and falls back to the pipeline atom's own created_at when no event
 * has landed yet OR when the pipeline atom is itself the latest
 * timestamp.
 */
function pipelineLastEventAt(
  index: ReadonlyMap<string, { ts: number; iso: string }>,
  pipeline: IntentOutcomeSourceAtom,
): string {
  const fromIndex = index.get(pipeline.id);
  if (fromIndex === undefined) return pipeline.created_at;
  const pipelineTs = parseIsoTs(pipeline.created_at);
  if (Number.isFinite(pipelineTs) && pipelineTs >= fromIndex.ts) {
    return pipeline.created_at;
  }
  return fromIndex.iso;
}

/**
 * Build a sample row from a pipeline atom + the synthesized outcome.
 * The synthesizer already derived a title (handles seed-intent
 * fallback); we read it straight off the outcome so two surfaces don't
 * disagree on what the row says.
 */
function makeRow(
  pipeline: IntentOutcomeSourceAtom,
  title: string | null,
  lastEventAt: string,
): BucketedRow {
  const ts = parseIsoTs(lastEventAt);
  return {
    pipeline_id: pipeline.id,
    title: title ?? pipeline.id,
    last_event_at: lastEventAt,
    last_event_ts: Number.isFinite(ts) ? ts : 0,
  };
}

/**
 * Sort recent-first and slice to the sample cap. Stable across runs:
 * ties broken by pipeline_id ascending so the same fixture yields the
 * same order regardless of input iteration order.
 */
function topNByRecency(
  rows: ReadonlyArray<BucketedRow>,
  cap: number,
): ReadonlyArray<PulsePipelineSummaryRow> {
  const sorted = [...rows].sort((a, b) => {
    if (a.last_event_ts !== b.last_event_ts) return b.last_event_ts - a.last_event_ts;
    return a.pipeline_id.localeCompare(b.pipeline_id);
  });
  return sorted.slice(0, cap).map((row) => ({
    pipeline_id: row.pipeline_id,
    title: row.title,
    last_event_at: row.last_event_at,
  }));
}

/**
 * Aggregate the live atom set into the Pulse pipeline-state summary.
 *
 * The classification rules:
 *   - `running`                   : pipeline_state in {pending, running}
 *   - `dispatched_pending_merge`  : intent-outcome state ===
 *                                    'intent-dispatched-pending-review'
 *   - `intent_fulfilled`          : intent-outcome state ===
 *                                    'intent-fulfilled' (merged PR observed)
 *
 * The three buckets are mutually exclusive by construction: a pipeline
 * is `running` (in flight) OR it has dispatched (and waits on merge OR
 * has merged) OR it's terminal-without-merge (not in any bucket). The
 * summary surfaces the active subset; terminal failures live elsewhere
 * on /pipelines.
 *
 * `now` is injected for determinism in tests; the handler passes
 * `Date.now()`.
 */
export function buildPulsePipelineSummary(
  atoms: ReadonlyArray<IntentOutcomeSourceAtom>,
  now: number,
): PulsePipelineSummary {
  const running: BucketedRow[] = [];
  const dispatched: BucketedRow[] = [];
  const fulfilled: BucketedRow[] = [];
  let total = 0;

  // Pre-index ONCE so the per-pipeline lookup below is O(1). See
  // latestStageEventByPipeline for the O(P x N) -> O(N) rationale.
  const lastEventIndex = latestStageEventByPipeline(atoms);

  for (const atom of atoms) {
    if (atom.type !== 'pipeline') continue;
    if (!isCleanLive(atom)) continue;
    total += 1;
    const outcome = buildIntentOutcome(atoms, atom.id, now);
    const lastEventAt = pipelineLastEventAt(lastEventIndex, atom);

    // Running bucket reads the pipeline atom's own pipeline_state to
    // catch the earliest signal: the intent-outcome's `intent-running`
    // also covers paused-ish states (it ladders through), but the
    // operator's question for the tile is literally "what's in flight
    // RIGHT NOW", so `pending|running` on the pipeline atom is the
    // tightest definition. HIL-paused pipelines surface in the
    // dispatched-pending-merge bucket only when a PR is open.
    const state = atom.pipeline_state ?? 'pending';
    if (state === 'pending' || state === 'running') {
      running.push(makeRow(atom, outcome.title, lastEventAt));
    }

    // The intent-outcome synthesizer's TRUE-outcome ladder collapses
    // every signal into a single state. We read it verbatim so a
    // pipeline that paints "fulfilled" in the detail view paints
    // "fulfilled" here -- no second classifier to drift from the
    // first.
    if (outcome.state === 'intent-dispatched-pending-review') {
      dispatched.push(makeRow(atom, outcome.title, lastEventAt));
    } else if (outcome.state === 'intent-fulfilled') {
      fulfilled.push(makeRow(atom, outcome.title, lastEventAt));
    }
  }

  return {
    computed_at: new Date(now).toISOString(),
    running: running.length,
    dispatched_pending_merge: dispatched.length,
    intent_fulfilled: fulfilled.length,
    total,
    samples: {
      running: topNByRecency(running, MAX_PULSE_SAMPLE),
      dispatched_pending_merge: topNByRecency(dispatched, MAX_PULSE_SAMPLE),
      intent_fulfilled: topNByRecency(fulfilled, MAX_PULSE_SAMPLE),
    },
  };
}
