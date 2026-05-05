/**
 * Pure projection: pipeline_id -> post-dispatch lifecycle.
 *
 * The deep planning pipeline emits a chain of stage atoms that the
 * existing /api/pipelines.detail surface renders. After dispatch-stage
 * exits, the chain continues but the events live in DIFFERENT atom
 * types that the pipelines projection alone never sees:
 *
 *   pipeline -> dispatch-record (counts: scanned/dispatched/failed)
 *      -> plan (the plan-stage's output atom; its metadata.pipeline_id
 *         points back at us)
 *      -> code-author-invoked observation (executor result + PR url)
 *      -> pr-observation atoms (CI + CR + merge-state snapshots)
 *      -> plan-merge-settled (canonical "merged" signal)
 *
 * This module stitches that downstream chain so the operator sees the
 * full intent-to-merge picture in one place. It is pure (no I/O, no
 * globals, no time): the handler in server/index.ts feeds the full
 * atom array; this module folds it into a wire shape.
 *
 * Read-only by construction. Writes route through existing CLIs per
 * apps/console/CLAUDE.md. Mirrors the pure-helper pattern used by
 * pipelines.ts and plan-state-lifecycle.ts so the three projections
 * compose cleanly in handlePipelineLifecycle.
 *
 * The projection deliberately does NOT duplicate the pipelines.ts
 * stage rollup: the post-dispatch view starts where the pipelines.ts
 * view ends. Callers stack the two for the full top-to-bottom render.
 */
import type {
  PipelineLifecycle,
  PipelineLifecycleCheckCounts,
  PipelineLifecycleCodeAuthorInvocation,
  PipelineLifecycleDispatchRecord,
  PipelineLifecycleMerge,
  PipelineLifecycleObservation,
  PipelineLifecycleSourceAtom,
} from './pipeline-lifecycle-types.js';
import { readObject, readString } from './projection-helpers.js';

/**
 * Coerce an unknown metadata value to a finite number, or null.
 * Local because this module's contract returns `null` on missing /
 * non-numeric values (vs pipelines.ts which returns `0`). A future
 * canon-driven alignment of the two contracts will move this into
 * projection-helpers.ts; for now the differing fallback shape keeps
 * each module's downstream guards intact.
 */
function readNumber(meta: Readonly<Record<string, unknown>>, key: string): number | null {
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Live-atom filter: same shape as pipelines.ts so a tainted or
 * superseded atom does not slip into the lifecycle projection.
 */
function isCleanLive(atom: PipelineLifecycleSourceAtom): boolean {
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Pick the dispatch-record atom whose metadata.pipeline_id matches.
 * The runtime emits at most one per pipeline; a re-run would write a
 * new atom rather than supersede the old one, but if multiple are
 * found we return the most recent so the operator sees current state.
 */
function pickDispatchRecord(
  atoms: ReadonlyArray<PipelineLifecycleSourceAtom>,
  pipelineId: string,
): PipelineLifecycleSourceAtom | null {
  let chosen: PipelineLifecycleSourceAtom | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'dispatch-record') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    if (!chosen || atom.created_at > chosen.created_at) chosen = atom;
  }
  return chosen;
}

/**
 * Pick the plan atom whose metadata.pipeline_id matches the requested
 * pipeline. A pipeline produces exactly one plan via the plan-stage,
 * but we still pick the most recent if more are present so a re-run
 * surfaces the live plan rather than a stale one.
 */
function pickPlanAtom(
  atoms: ReadonlyArray<PipelineLifecycleSourceAtom>,
  pipelineId: string,
): PipelineLifecycleSourceAtom | null {
  let chosen: PipelineLifecycleSourceAtom | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'plan') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'pipeline_id') !== pipelineId) continue;
    if (!chosen || atom.created_at > chosen.created_at) chosen = atom;
  }
  return chosen;
}

/**
 * Pick the most recent code-author-invoked observation atom whose
 * metadata.plan_id matches. The executor writes one per dispatch; a
 * re-dispatch produces a fresh atom, so picking the latest gives the
 * live invocation result.
 *
 * Strict kind filter: ONLY `kind === 'code-author-invoked'` qualifies.
 * handlePlanLifecycle uses a looser `*-invoked` glob because that
 * surface stitches every executor's invocation row; this projection
 * is specifically the post-dispatch lifecycle for the code-author
 * sub-actor. Accepting other `*-invoked` kinds here would silently
 * mix pr-fix-invoked / future-actor-invoked into the row and
 * mislead the operator about which executor opened the PR.
 */
function pickCodeAuthorInvoked(
  atoms: ReadonlyArray<PipelineLifecycleSourceAtom>,
  planId: string,
): PipelineLifecycleSourceAtom | null {
  let chosen: PipelineLifecycleSourceAtom | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'observation') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'kind') !== 'code-author-invoked') continue;
    if (readString(meta, 'plan_id') !== planId) continue;
    if (!chosen || atom.created_at > chosen.created_at) chosen = atom;
  }
  return chosen;
}

/**
 * Pick the most recent pr-observation atom that derives from the plan.
 * One per HEAD update; the latest is the canonical "current state of
 * the PR" view. Mirrors handlePlanLifecycle's pr-observation pick.
 */
function pickPrObservation(
  atoms: ReadonlyArray<PipelineLifecycleSourceAtom>,
  planId: string,
): PipelineLifecycleSourceAtom | null {
  let chosen: PipelineLifecycleSourceAtom | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'observation') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'kind') !== 'pr-observation') continue;
    if (readString(meta, 'plan_id') !== planId) continue;
    if (!chosen || atom.created_at > chosen.created_at) chosen = atom;
  }
  return chosen;
}

/**
 * Pick the plan-merge-settled atom for the plan. The reconciler writes
 * one when the PR observation reports MERGED; pick the latest so a
 * superseded re-merge surfaces correctly.
 */
function pickMergeSettled(
  atoms: ReadonlyArray<PipelineLifecycleSourceAtom>,
  planId: string,
): PipelineLifecycleSourceAtom | null {
  let chosen: PipelineLifecycleSourceAtom | null = null;
  for (const atom of atoms) {
    if (atom.type !== 'plan-merge-settled') continue;
    if (!isCleanLive(atom)) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (readString(meta, 'plan_id') !== planId) continue;
    if (!chosen || atom.created_at > chosen.created_at) chosen = atom;
  }
  return chosen;
}

/**
 * Parse the check-runs section of a pr-observation atom's `content`
 * string into per-state counts.
 *
 * Why parse content: the metadata block carries `counts.check_runs`
 * (an integer total) but does NOT break out per-state counts; the
 * substrate emits the per-check states only inside the human-readable
 * content for now. Parsing the content gives the UI three numbers
 * (green / red / pending) without a substrate change, and the parser
 * is forward-compatible: if a future atom shape adds a structured
 * `check_states` array, this function can prefer that and fall back
 * to the line-parser only when missing.
 *
 * Format the runner emits today:
 *   `check-runs: <N>`
 *   `  - <name>: <state>`
 *   ... <bullets continue> ...
 *   `legacy statuses: <M>`             <- next top-level header
 *   ... or `unresolved line comments: <K>` etc.
 * where <state> is one of github's check-run conclusions
 * (success / failure / cancelled / skipped / queued / in_progress /
 * timed_out / action_required / neutral / pending). Mapping:
 *   green   <- success, neutral, skipped
 *   red     <- failure, timed_out, cancelled, action_required
 *   pending <- queued, in_progress, pending, anything unrecognized
 *
 * Unrecognized states bucket as `pending` (loud-fail fallback) so an
 * unexpected substrate addition doesn't silently inflate the green
 * count.
 *
 * Scoping: the parser ONLY consumes bullets that appear AFTER a
 * `check-runs:` header line and BEFORE the next top-level header
 * (any non-blank, non-indented line that isn't a bullet). This
 * prevents bullets in adjacent sections (`legacy statuses:` body,
 * future bullet groups, etc.) from inflating the counts. If the
 * substrate emits no `check-runs:` header, total = 0 is the correct
 * projection: there are no checks to count.
 */
export function parseCheckCountsFromContent(content: string): PipelineLifecycleCheckCounts {
  let green = 0;
  let red = 0;
  let pending = 0;
  let total = 0;
  let inCheckRunsBlock = false;
  // Detect the block boundary explicitly so a future change to the
  // emit shape (extra section between check-runs and legacy statuses)
  // doesn't silently leak adjacent bullets into the count. The block
  // ends when we see another top-level (non-indented) header line.
  const lines = content.split('\n');
  for (const line of lines) {
    if (/^check-runs:\s*\d+/i.test(line)) {
      // Header for the section we want; start counting subsequent bullets.
      inCheckRunsBlock = true;
      continue;
    }
    if (!inCheckRunsBlock) continue;
    // A top-level header (non-indented, non-empty, non-bullet) ends
    // the block. Lines like `legacy statuses: 0`, `unresolved line
    // comments: 0`, `body-scoped nits: 0`, or any other left-anchored
    // header break out cleanly. Blank lines alone are tolerated (some
    // emitters wrap groups in blank padding) and do not terminate the
    // block.
    if (/^[A-Za-z]/.test(line)) {
      inCheckRunsBlock = false;
      continue;
    }
    const match = line.match(/^\s+-\s+.+?:\s+([a-z_]+)\s*$/i);
    if (!match || !match[1]) continue;
    const state = match[1].toLowerCase();
    total += 1;
    if (state === 'success' || state === 'neutral' || state === 'skipped') {
      green += 1;
    } else if (
      state === 'failure'
      || state === 'failed'
      || state === 'timed_out'
      || state === 'cancelled'
      || state === 'action_required'
    ) {
      red += 1;
    } else {
      // queued / in_progress / pending / anything else.
      pending += 1;
    }
  }
  return { total, green, red, pending };
}

/**
 * Parse the legacy-statuses section of a pr-observation atom's
 * `content`. Mirrors parseCheckCountsFromContent but scoped to the
 * separate `legacy statuses: <N>` block. Legacy statuses use the
 * same GitHub state vocabulary; the meaningful split is "any red"
 * (a hard merge gate, e.g. CodeRabbit failure) vs "all green"
 * (advisory). Today the substrate emits per-status states the same
 * way it does check-runs.
 *
 * Returns total + red counts. A count of 0 in both fields can mean
 * either "no statuses observed" or "no `legacy statuses:` header in
 * content"; consumers distinguish via the metadata.counts.legacy_statuses
 * field separately.
 */
export function parseLegacyStatusCountsFromContent(content: string): {
  total: number;
  red: number;
} {
  let total = 0;
  let red = 0;
  let inBlock = false;
  const lines = content.split('\n');
  for (const line of lines) {
    if (/^legacy\s+statuses:\s*\d+/i.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^[A-Za-z]/.test(line)) {
      inBlock = false;
      continue;
    }
    const match = line.match(/^\s+-\s+.+?:\s+([a-z_]+)\s*$/i);
    if (!match || !match[1]) continue;
    total += 1;
    const state = match[1].toLowerCase();
    // Red bucket mirrors parseCheckCountsFromContent's red set so the
    // two parsers agree on what a "red" GitHub status looks like:
    // failure / failed / error / cancelled / timed_out / action_required.
    // Aligning here matters because the legacy-status surface and the
    // check-runs surface BOTH report a CR-failure as a red signal in
    // the verdict ladder; if their definitions of "red" drift, a
    // legacy-status timed_out (which legitimately fails a merge gate)
    // would silently project as green and mislead the verdict.
    if (
      state === 'failure'
      || state === 'failed'
      || state === 'error'
      || state === 'cancelled'
      || state === 'timed_out'
      || state === 'action_required'
    ) {
      red += 1;
    }
  }
  return { total, red };
}

/**
 * Project the pipeline post-dispatch lifecycle from the atom set.
 *
 * Returns a fully-populated lifecycle envelope: every block is an
 * optional field that is null when the corresponding atom is not in
 * the store. The UI renders progressively: when `dispatch_record` is
 * null, only the "PR pending" placeholder shows; when each downstream
 * block lands, its row materializes.
 *
 * Pure: deterministic for a given input, no globals, no time.
 */
export function buildPipelineLifecycle(
  atoms: ReadonlyArray<PipelineLifecycleSourceAtom>,
  pipelineId: string,
): PipelineLifecycle {
  const dispatchAtom = pickDispatchRecord(atoms, pipelineId);
  const planAtom = pickPlanAtom(atoms, pipelineId);

  /*
   * Dispatch record block. Surfaces the three counts the dispatch-stage
   * emits + the substrate-side dispatch_status. When `failed > 0`, the
   * dispatch-record atom itself does NOT carry the error_message: the
   * dispatcher writes that to the plan atom's metadata.dispatch_result.
   * We pull it from there if available so the operator sees the cause
   * inline rather than having to grep the plan atom.
   */
  let dispatchBlock: PipelineLifecycleDispatchRecord | null = null;
  if (dispatchAtom) {
    const meta = (dispatchAtom.metadata ?? {}) as Record<string, unknown>;
    const stageOutput = readObject(meta, 'stage_output');
    const planMeta = (planAtom?.metadata ?? {}) as Record<string, unknown>;
    const dispatchResult = readObject(planMeta, 'dispatch_result');
    const errorMessage = dispatchResult && dispatchResult['kind'] === 'error'
      ? readString(dispatchResult, 'message')
      : null;
    dispatchBlock = {
      atom_id: dispatchAtom.id,
      pipeline_id: pipelineId,
      dispatch_status: stageOutput ? readString(stageOutput, 'dispatch_status') : null,
      scanned: stageOutput ? (readNumber(stageOutput, 'scanned') ?? 0) : 0,
      dispatched: stageOutput ? (readNumber(stageOutput, 'dispatched') ?? 0) : 0,
      failed: stageOutput ? (readNumber(stageOutput, 'failed') ?? 0) : 0,
      cost_usd: stageOutput ? (readNumber(stageOutput, 'cost_usd') ?? 0) : 0,
      error_message: errorMessage,
      at: dispatchAtom.created_at,
    };
  }

  // Bail early if no plan atom exists -- there's nothing post-plan to
  // project. Operator sees "Dispatch outcome" alone, which is correct:
  // a pipeline that hasn't reached plan-stage hasn't reached dispatch.
  if (!planAtom) {
    return {
      pipeline_id: pipelineId,
      plan_id: null,
      dispatch_record: dispatchBlock,
      code_author_invoked: null,
      observation: null,
      merge: null,
    };
  }

  const planId = planAtom.id;
  const codeAuthorAtom = pickCodeAuthorInvoked(atoms, planId);
  const prObservationAtom = pickPrObservation(atoms, planId);
  const mergeAtom = pickMergeSettled(atoms, planId);

  /*
   * Code-author invocation block. The executor_result kind is either
   * 'dispatched' (PR opened) or 'error' (silent-skip with reason +
   * stage). When 'error' we pull the reason + stage so the UI can
   * distinguish "drafter ran but couldn't apply" from "PR opened
   * cleanly" without re-fetching the atom.
   */
  let codeAuthorBlock: PipelineLifecycleCodeAuthorInvocation | null = null;
  if (codeAuthorAtom) {
    const meta = (codeAuthorAtom.metadata ?? {}) as Record<string, unknown>;
    const executorResult = readObject(meta, 'executor_result');
    const correlationId = readString(meta, 'correlation_id');
    const kind = executorResult ? readString(executorResult, 'kind') : null;
    codeAuthorBlock = {
      atom_id: codeAuthorAtom.id,
      plan_id: planId,
      correlation_id: correlationId,
      kind: kind === 'dispatched' || kind === 'error' ? kind : null,
      pr_number: executorResult ? readNumber(executorResult, 'pr_number') : null,
      pr_html_url: executorResult ? readString(executorResult, 'pr_html_url') : null,
      branch_name: executorResult ? readString(executorResult, 'branch_name') : null,
      commit_sha: executorResult ? readString(executorResult, 'commit_sha') : null,
      reason: executorResult && kind === 'error' ? readString(executorResult, 'reason') : null,
      stage: executorResult && kind === 'error' ? readString(executorResult, 'stage') : null,
      at: codeAuthorAtom.created_at,
    };
  }

  /*
   * PR observation block. The pr-observation atom captures the most
   * recent CI + CR + merge-state snapshot. We surface:
   *   - pr_state          OPEN | CLOSED | MERGED
   *   - merge_state_status BEHIND | DIRTY | BLOCKED | UNSTABLE | CLEAN
   *   - mergeable          boolean
   *   - check counts       parsed per-state from content
   *   - submitted_reviews / line_comments / body_nits  (CR signal)
   *
   * The CR verdict (approved / has-findings / pending / missing) is a
   * derived signal the UI computes from the counts, NOT a metadata
   * field on the atom; see PipelineLifecycle.tsx for the resolver.
   */
  let observationBlock: PipelineLifecycleObservation | null = null;
  if (prObservationAtom) {
    const meta = (prObservationAtom.metadata ?? {}) as Record<string, unknown>;
    const counts = readObject(meta, 'counts');
    const prRef = readObject(meta, 'pr');
    const mergeable = meta['mergeable'] === true || meta['mergeable'] === false
      ? (meta['mergeable'] as boolean)
      : null;
    const legacy = parseLegacyStatusCountsFromContent(prObservationAtom.content);
    observationBlock = {
      atom_id: prObservationAtom.id,
      plan_id: planId,
      pr_number: prRef ? readNumber(prRef, 'number') : null,
      pr_state: readString(meta, 'pr_state'),
      pr_title: readString(meta, 'pr_title'),
      head_sha: readString(meta, 'head_sha'),
      mergeable,
      merge_state_status: readString(meta, 'merge_state_status'),
      observed_at: readString(meta, 'observed_at') ?? prObservationAtom.created_at,
      submitted_reviews: counts ? (readNumber(counts, 'submitted_reviews') ?? 0) : 0,
      line_comments: counts ? (readNumber(counts, 'line_comments') ?? 0) : 0,
      body_nits: counts ? (readNumber(counts, 'body_nits') ?? 0) : 0,
      // counts.legacy_statuses is the total reported by the runner;
      // the per-state break-down (red vs green) is parsed from the
      // content text the same way check-runs are parsed. Per canon
      // dev-multi-surface-review-observation, the legacy-status
      // surface is load-bearing because the `CodeRabbit` legacy
      // status posts there and a red entry is a hard merge-gate
      // signal the verdict logic must consider.
      legacy_statuses: counts ? (readNumber(counts, 'legacy_statuses') ?? 0) : 0,
      legacy_statuses_red: legacy.red,
      check_counts: parseCheckCountsFromContent(prObservationAtom.content),
    };
  }

  /*
   * Merge block. Sourced from plan-merge-settled (canonical "merged"
   * signal written by the reconciler). The atom carries the PR ref
   * + target_plan_state; we surface settled_at + the merger via the
   * principal_id of the settling actor (typically pr-landing-agent).
   *
   * Optional: when no plan-merge-settled atom exists but the latest
   * pr-observation reports pr_state=MERGED, we still render the row
   * with `settled_at` from the observation so the UI doesn't lose the
   * merged-but-not-yet-reconciled state. Same fallback handlePlanLifecycle
   * uses for late-arriving reconciliations.
   */
  let mergeBlock: PipelineLifecycleMerge | null = null;
  if (mergeAtom) {
    const meta = (mergeAtom.metadata ?? {}) as Record<string, unknown>;
    // Prefer a commit SHA on the settled atom itself, then fall back
    // to the head_sha on the latest pr-observation so the operator
    // doesn't lose the merge commit on the row when the reconciler
    // doesn't propagate it yet. Earlier shape unconditionally
    // returned null for the commit, which CR flagged as a regression
    // for any chain that already has the observation pinned.
    const commitFromMergeAtom = readString(meta, 'merge_commit_sha')
      ?? readString(meta, 'head_sha');
    mergeBlock = {
      atom_id: mergeAtom.id,
      plan_id: planId,
      pr_state: readString(meta, 'pr_state'),
      target_plan_state: readString(meta, 'target_plan_state'),
      merge_commit_sha: commitFromMergeAtom ?? observationBlock?.head_sha ?? null,
      settled_at: readString(meta, 'settled_at') ?? mergeAtom.created_at,
      merger_principal_id: mergeAtom.principal_id,
    };
  } else if (observationBlock && observationBlock.pr_state === 'MERGED') {
    mergeBlock = {
      atom_id: null,
      plan_id: planId,
      pr_state: 'MERGED',
      target_plan_state: null,
      merge_commit_sha: observationBlock.head_sha,
      settled_at: observationBlock.observed_at,
      merger_principal_id: null,
    };
  }

  return {
    pipeline_id: pipelineId,
    plan_id: planId,
    dispatch_record: dispatchBlock,
    code_author_invoked: codeAuthorBlock,
    observation: observationBlock,
    merge: mergeBlock,
  };
}
