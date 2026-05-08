/**
 * Pure synthesizer: pipeline_id -> aggregated intent-outcome state.
 *
 * The /pipelines/<id> view today shows 5 stage cards + a post-dispatch
 * lifecycle but has no "did the intent ship a PR yet?" summary at the
 * top. Operators have to scroll AND mentally aggregate signals across
 * dispatch_record + code-author-invoked + pr-observation +
 * plan-merge-settled to answer "is this intent fulfilled?".
 *
 * This module stitches the same atoms the existing projections already
 * walk into one synthesized state-pill + summary line. It is pure (no
 * I/O, no globals, no time): the handler in server/index.ts feeds it
 * the full atom array; this module folds it into a wire shape.
 *
 * Read-only by construction. Writes route through existing CLIs per
 * apps/console/CLAUDE.md. Mirrors the pure-helper pattern used by
 * pipelines.ts and pipeline-lifecycle.ts so the three projections
 * compose cleanly.
 *
 * TRUE-outcome semantics (load-bearing):
 *   - `intent-fulfilled` requires an OBSERVED merged PR (plan-merge-settled
 *     atom OR pr-observation reporting pr_state=MERGED). plan_state alone
 *     is NOT enough; a plan can be marked succeeded yet have no merged PR.
 *   - `intent-dispatch-failed` covers BOTH dispatched=0 (envelope mismatch,
 *     plan confidence too low, etc) AND the case where every PR opened
 *     was eventually closed without merge.
 *   - The synthesizer never auto-fulfills based on a code-author-invoked
 *     atom alone -- that just opens a PR; merge is a downstream signal.
 */
import type {
  IntentOutcome,
  IntentOutcomeSkipReason,
  IntentOutcomeSourceAtom,
  IntentOutcomeState,
} from './intent-outcome-types.js';
import { buildPipelineLifecycle } from './pipeline-lifecycle.js';
import type { PipelineLifecycleSourceAtom } from './pipeline-lifecycle-types.js';
import { readString } from './projection-helpers.js';

/**
 * Live-atom filter: same shape as pipelines.ts and
 * pipeline-lifecycle.ts so a tainted or superseded atom never slips
 * into the synthesis.
 */
function isCleanLive(atom: IntentOutcomeSourceAtom): boolean {
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Pick the pipeline atom by id. The synthesizer is forgiving: a
 * dispatch-record may exist for a pipeline whose root atom we cannot
 * find (legacy / partial chain). We surface the dispatch-record's
 * pipeline_id back to the operator either way; this getter just
 * resolves the rich metadata when available.
 */
function pickPipelineAtom(
  atoms: ReadonlyArray<IntentOutcomeSourceAtom>,
  pipelineId: string,
): IntentOutcomeSourceAtom | null {
  for (const atom of atoms) {
    if (atom.type !== 'pipeline') continue;
    if (atom.id !== pipelineId) continue;
    if (!isCleanLive(atom)) continue;
    return atom;
  }
  return null;
}

/**
 * Resolve the operator-intent atom that seeded this pipeline. The
 * pipeline atom carries `provenance.derived_from = [intent-id]`; we
 * walk that chain and pick the first operator-intent atom we find.
 *
 * Defensive: a pipeline whose derived_from chain is empty (or whose
 * seed atom is not an operator-intent type) returns null. The card
 * still renders -- just without the "time since intent landed" line.
 */
function resolveOperatorIntent(
  atoms: ReadonlyArray<IntentOutcomeSourceAtom>,
  pipeline: IntentOutcomeSourceAtom | null,
): IntentOutcomeSourceAtom | null {
  if (!pipeline) return null;
  const provenance = pipeline.provenance ?? {};
  const derived = (provenance as Record<string, unknown>)['derived_from'];
  if (!Array.isArray(derived)) return null;
  // Quick lookup map for O(1) resolution rather than O(N) re-scan.
  const byId = new Map<string, IntentOutcomeSourceAtom>();
  for (const atom of atoms) {
    if (!isCleanLive(atom)) continue;
    byId.set(atom.id, atom);
  }
  for (const id of derived) {
    if (typeof id !== 'string' || id.length === 0) continue;
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (candidate.type === 'operator-intent') return candidate;
  }
  return null;
}

/**
 * Format duration in ms to a short human label. Mirrors the
 * formatDurationMs in the client so the summary line that the server
 * synthesizes reads identically to client-rendered durations.
 */
function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

/**
 * Walk events for a pipeline and compute (a) total stage count
 * (distinct stage_name values seen) and (b) completed-stage count
 * (those whose latest event is exit-success or exit-failure).
 *
 * Pure-data alternative to importing pipelines.ts's full fold: we only
 * need these two numbers, and the lifecycle helper already does the
 * dispatch-record + plan side. Avoiding the full pipelines fold here
 * keeps this synthesizer's dependencies tight (only projection-helpers
 * + pipeline-lifecycle).
 */
function countStages(
  atoms: ReadonlyArray<IntentOutcomeSourceAtom>,
  pipelineId: string,
): { stages: number; completed: number; durationMs: number; lastEventIso: string | null } {
  const seen = new Set<string>();
  // Track latest transition per stage so we can bucket completions.
  const latestTransition = new Map<string, { transition: string; ts: number; iso: string }>();
  let totalDuration = 0;
  let lastEventTs = -Infinity;
  let lastEventIso: string | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-stage-event') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    const stageName = readString(meta, 'stage_name');
    const transition = readString(meta, 'transition');
    if (!stageName || !transition) continue;
    seen.add(stageName);
    const dur = meta['duration_ms'];
    if (typeof dur === 'number' && Number.isFinite(dur)) {
      totalDuration += dur;
    }
    const ts = Date.parse(atom.created_at);
    if (Number.isFinite(ts)) {
      if (ts > lastEventTs) {
        lastEventTs = ts;
        lastEventIso = atom.created_at;
      }
      const prior = latestTransition.get(stageName);
      if (!prior || ts >= prior.ts) {
        latestTransition.set(stageName, { transition, ts, iso: atom.created_at });
      }
    }
  }
  let completed = 0;
  for (const v of latestTransition.values()) {
    if (v.transition === 'exit-success' || v.transition === 'exit-failure') completed += 1;
  }
  return {
    stages: seen.size,
    completed,
    durationMs: totalDuration,
    lastEventIso,
  };
}

/**
 * Determine whether the pipeline is currently HIL-paused. The
 * pipeline atom's top-level `pipeline_state` is the canonical signal;
 * we also check the latest stage-event for hil-pause WITHOUT a
 * subsequent hil-resume as a backstop for older atoms that didn't
 * propagate state to the pipeline atom.
 */
function isHilPaused(
  pipeline: IntentOutcomeSourceAtom | null,
  atoms: ReadonlyArray<IntentOutcomeSourceAtom>,
  pipelineId: string,
): boolean {
  if (pipeline?.pipeline_state === 'hil-paused') return true;
  // Backstop: per-stage latest-event check.
  const latestPerStage = new Map<string, { transition: string; ts: number }>();
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-stage-event') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    const stageName = readString(meta, 'stage_name');
    const transition = readString(meta, 'transition');
    if (!stageName || !transition) continue;
    const ts = Date.parse(atom.created_at);
    if (!Number.isFinite(ts)) continue;
    const prior = latestPerStage.get(stageName);
    if (!prior || ts >= prior.ts) {
      latestPerStage.set(stageName, { transition, ts });
    }
  }
  for (const v of latestPerStage.values()) {
    if (v.transition === 'hil-pause') return true;
  }
  return false;
}

/**
 * Format an ISO timestamp for the summary line. Returns the time
 * portion in HH:MMZ for compactness; the full datetime is one click
 * away in the rest of the detail page.
 */
function formatHmZ(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}Z`;
}

/**
 * Build the IntentOutcome envelope. See module-doc for the
 * TRUE-outcome semantics this synthesizer encodes.
 *
 * The handler's `now` is injected for testability; production callers
 * pass `Date.now()`.
 */
export function buildIntentOutcome(
  atoms: ReadonlyArray<IntentOutcomeSourceAtom>,
  pipelineId: string,
  now: number,
): IntentOutcome {
  const pipeline = pickPipelineAtom(atoms, pipelineId);
  const intent = resolveOperatorIntent(atoms, pipeline);
  /*
   * Re-use the existing pipeline-lifecycle helper to read the
   * dispatch-record + code-author + pr-observation + merge atoms.
   * The two helpers consume compatible source-atom shapes (the
   * narrow shape pipeline-lifecycle.ts defines is a subset of the
   * shape this module accepts), so a downcast through the projection
   * is sound. Avoids re-implementing four atom-pickers here.
   */
  const lifecycleAtoms = atoms as unknown as ReadonlyArray<PipelineLifecycleSourceAtom>;
  const lifecycle = buildPipelineLifecycle(lifecycleAtoms, pipelineId);

  const stageStats = countStages(atoms, pipelineId);
  const paused = isHilPaused(pipeline, atoms, pipelineId);

  // Derive timestamps + cosmetic fields up-front; they feed both the
  // state derivation AND the summary line.
  const intentCreatedAt = intent ? Date.parse(intent.created_at) : NaN;
  const timeElapsedMs = Number.isFinite(intentCreatedAt) ? Math.max(0, now - intentCreatedAt) : 0;

  // expires_at lives at the atom envelope level (not inside metadata).
  const intentExpiresAt = intent && typeof intent.expires_at === 'string' && intent.expires_at.length > 0
    ? Date.parse(intent.expires_at)
    : NaN;
  const intentExpired = Number.isFinite(intentExpiresAt) && intentExpiresAt < now;

  const dispatchRecord = lifecycle.dispatch_record;
  const codeAuthor = lifecycle.code_author_invoked;
  const observation = lifecycle.observation;
  const merge = lifecycle.merge;

  const dispatchedCount = dispatchRecord ? dispatchRecord.dispatched : 0;
  const pipelineState = pipeline?.pipeline_state ?? null;
  const isMerged = (merge && merge.pr_state === 'MERGED')
    || (observation && observation.pr_state === 'MERGED');
  const prClosedUnmerged = observation && observation.pr_state === 'CLOSED';

  // Pull a pipeline title from the pipeline atom's content / metadata.
  const pipelineMeta = (pipeline?.metadata ?? {}) as Record<string, unknown>;
  const titleFromMeta = readString(pipelineMeta, 'title');
  const titleFromIntent = intent ? firstLine(intent.content) : null;
  const titleFromContent = pipeline ? firstLine(pipeline.content) : null;
  const title = titleFromMeta ?? titleFromIntent ?? titleFromContent;

  const mode = readString(pipelineMeta, 'mode');

  // ------------------------------------------------------------------
  // State derivation -- TRUE-outcome semantics. Order matters: the
  // first matching rung wins, so the ladder is from "most certain
  // terminal good" down to "no signal yet".
  // ------------------------------------------------------------------
  let state: IntentOutcomeState;
  if (isMerged) {
    state = 'intent-fulfilled';
  } else if (intentExpired && !isMerged) {
    /*
     * Intent expired without producing a merged PR. The synthesizer
     * treats this as abandoned regardless of what the pipeline did
     * downstream: the operator's authorization window closed, so any
     * downstream activity is moot from an autonomous-flow perspective.
     */
    state = 'intent-abandoned';
  } else if (paused) {
    state = 'intent-paused';
  } else if (codeAuthor && codeAuthor.kind === 'dispatched' && codeAuthor.pr_number) {
    /*
     * A code-author invocation produced a real PR. The PR is in flight
     * (not merged, since the isMerged rung above didn't fire). The
     * observation may be missing entirely (early state) or present
     * with pr_state=OPEN; either way the row is "pending review".
     */
    if (prClosedUnmerged) {
      // PR was opened but later closed without merge -- a dispatch failure
      // by TRUE-outcome semantics: the chain produced no merged artifact.
      state = 'intent-dispatch-failed';
    } else {
      state = 'intent-dispatched-pending-review';
    }
  } else if (
    pipelineState === 'completed'
    && dispatchRecord
    && dispatchedCount === 0
  ) {
    /*
     * Pipeline finished but produced zero dispatches. This is the
     * canonical "envelope mismatch / plan confidence too low / etc"
     * failure mode; surface it as dispatch-failed with the skip
     * reason inline.
     */
    state = 'intent-dispatch-failed';
  } else if (
    codeAuthor
    && (codeAuthor.kind === 'noop' || codeAuthor.kind === 'error')
  ) {
    /*
     * Drafter ran but produced no PR (intentional no-op OR silent-skip
     * error). Both are "pipeline produced no merged artifact" outcomes
     * by TRUE-outcome semantics.
     */
    state = 'intent-dispatch-failed';
  } else if (pipelineState === 'failed') {
    state = 'intent-dispatch-failed';
  } else if (pipelineState === 'running' || pipelineState === 'pending') {
    state = 'intent-running';
  } else if (pipelineState === 'completed') {
    /*
     * Pipeline reports completed but we have no dispatch-record / no
     * code-author / no PR. Could be a legacy chain that didn't reach
     * dispatch-stage. Treat as dispatch-failed: the operator's intent
     * did not produce a merged PR.
     */
    state = 'intent-dispatch-failed';
  } else if (pipeline === null && dispatchRecord === null) {
    /*
     * No atoms at all reference this pipeline yet. The endpoint will
     * have already returned 404 before reaching here for a real miss;
     * this branch covers the synthesis-on-empty path the unit tests
     * exercise.
     */
    state = 'intent-unknown';
  } else {
    state = 'intent-running';
  }

  // ------------------------------------------------------------------
  // Skip reasons -- surfaced when dispatched=0 OR code-author halted.
  // ------------------------------------------------------------------
  const skipReasons: IntentOutcomeSkipReason[] = [];
  if (dispatchRecord && dispatchedCount === 0 && dispatchRecord.error_message) {
    skipReasons.push({
      reason: dispatchRecord.error_message,
      source: 'dispatch-record',
    });
  }
  if (codeAuthor && codeAuthor.kind === 'error' && codeAuthor.reason) {
    skipReasons.push({
      reason: codeAuthor.reason,
      source: 'code-author',
    });
  }
  if (codeAuthor && codeAuthor.kind === 'noop' && codeAuthor.reason) {
    skipReasons.push({
      reason: codeAuthor.reason,
      source: 'code-author',
    });
  }
  // Plan-side dispatch_result fallback: when dispatch-record carried no
  // error_message but the plan atom's dispatch_result has one, surface it.
  // The pipeline-lifecycle helper already pulled error_message from the
  // plan atom; we add a stand-alone entry only when the source is
  // structurally distinct from the dispatch-record entry above.
  // (No second pass needed today; the dispatch-record path covers it.)

  // ------------------------------------------------------------------
  // Summary line -- one short sentence for the card body.
  // ------------------------------------------------------------------
  const summary = buildSummary({
    state,
    dispatchedCount,
    stages: stageStats.stages,
    durationMs: stageStats.durationMs,
    mergeAt: merge?.settled_at ?? (observation?.pr_state === 'MERGED' ? observation.observed_at : null),
    prNumber: codeAuthor?.pr_number ?? observation?.pr_number ?? null,
    skipReason: skipReasons[0]?.reason ?? null,
    pausedStage: paused ? lastPausedStageName(atoms, pipelineId) : null,
    runningStage: pipelineState === 'running'
      ? readString(pipelineMeta, 'current_stage')
      : null,
    pausedFromPipeline: pipelineState === 'hil-paused'
      ? readString(pipelineMeta, 'current_stage')
      : null,
  });

  return {
    pipeline_id: pipelineId,
    state,
    summary,
    operator_intent_atom_id: intent?.id ?? null,
    pipeline_atom_id: pipeline?.id ?? null,
    mode,
    title,
    stage_count: stageStats.stages,
    stage_completed_count: stageStats.completed,
    total_duration_ms: stageStats.durationMs,
    time_elapsed_ms: timeElapsedMs,
    dispatched_count: dispatchedCount,
    pr_number: codeAuthor?.pr_number ?? observation?.pr_number ?? null,
    pr_url: codeAuthor?.pr_html_url ?? null,
    pr_title: observation?.pr_title ?? null,
    merge_commit_sha: merge?.merge_commit_sha ?? observation?.head_sha ?? null,
    pr_merged_at: merge?.settled_at ?? (observation?.pr_state === 'MERGED' ? observation.observed_at : null),
    skip_reasons: skipReasons,
    computed_at: new Date(now).toISOString(),
  };
}

/**
 * Find the stage_name on the most recent hil-pause event so the
 * summary line can name the stage the operator is gated on.
 */
function lastPausedStageName(
  atoms: ReadonlyArray<IntentOutcomeSourceAtom>,
  pipelineId: string,
): string | null {
  let chosen: { name: string; ts: number } | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'pipeline-stage-event') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    if (readString(meta, 'transition') !== 'hil-pause') continue;
    const stageName = readString(meta, 'stage_name');
    if (!stageName) continue;
    const ts = Date.parse(atom.created_at);
    if (!Number.isFinite(ts)) continue;
    if (!chosen || ts > chosen.ts) {
      chosen = { name: stageName, ts };
    }
  }
  return chosen?.name ?? null;
}

/**
 * Build the human-readable summary for the card body. Pure -- the
 * caller passes every input it needs, so the function is trivially
 * unit-testable in isolation.
 */
export function buildSummary(input: {
  state: IntentOutcomeState;
  dispatchedCount: number;
  stages: number;
  durationMs: number;
  mergeAt: string | null;
  prNumber: number | null;
  skipReason: string | null;
  pausedStage: string | null;
  runningStage: string | null;
  pausedFromPipeline: string | null;
}): string {
  const dur = formatDurationShort(input.durationMs);
  const stagePart = input.stages > 0 ? `${input.stages} stage${input.stages === 1 ? '' : 's'}` : null;
  switch (input.state) {
    case 'intent-fulfilled': {
      const mergeT = formatHmZ(input.mergeAt);
      const prPart = input.prNumber ? `PR #${input.prNumber}` : 'PR';
      const pieces = [
        `Pipeline ran ${dur}`,
        stagePart,
        `dispatched ${input.dispatchedCount} ${input.dispatchedCount === 1 ? 'PR' : 'PRs'}`,
        prPart && mergeT ? `${prPart} merged at ${mergeT}` : (prPart ? `${prPart} merged` : null),
      ].filter(Boolean);
      return pieces.join(', ');
    }
    case 'intent-dispatched-pending-review': {
      const prPart = input.prNumber ? `PR #${input.prNumber}` : 'PR';
      const pieces = [
        `Pipeline ran ${dur}`,
        stagePart,
        `${prPart} open, awaiting review`,
      ].filter(Boolean);
      return pieces.join(', ');
    }
    case 'intent-dispatch-failed': {
      const head = `Pipeline ran ${dur}, dispatched ${input.dispatchedCount} ${input.dispatchedCount === 1 ? 'PR' : 'PRs'}`;
      if (input.skipReason) {
        return `${head} - ${input.skipReason}`;
      }
      return `${head} (no merged artifact)`;
    }
    case 'intent-paused': {
      const stage = input.pausedStage ?? input.pausedFromPipeline;
      if (stage) return `Pipeline paused for HIL at ${stage}`;
      return 'Pipeline paused for HIL';
    }
    case 'intent-running': {
      if (input.runningStage) return `Pipeline mid-execution at ${input.runningStage}`;
      if (stagePart) return `Pipeline mid-execution, ${stagePart} so far`;
      return 'Pipeline mid-execution';
    }
    case 'intent-abandoned':
      return 'Operator-intent expired or abandoned without a merged PR';
    case 'intent-unknown':
    default:
      return 'No pipeline state recorded yet';
  }
}

/**
 * First-line helper for content -> title fallback. Kept private to
 * the synthesizer because the format is bespoke (markdown heading
 * stripping, length cap matched to the card width, no ellipsis on
 * the wire).
 */
function firstLine(text: string): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^#{1,6}\s+/, '').trim();
    if (trimmed.length > 0) {
      return trimmed.length > 240 ? `${trimmed.slice(0, 239)}\u2026` : trimmed;
    }
  }
  return null;
}
