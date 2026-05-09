/**
 * Pipeline subgraph reaper.
 *
 * The deep-planning pipeline produces a multi-atom subgraph per run:
 * a root `pipeline` atom plus stage-event, stage-output, audit-finding,
 * agent-session, and agent-turn children. None of those atom types are
 * touched by the existing plan reaper at `./reaper.ts`, which only
 * abandons stale `proposed` plans. Without a sibling sweep over the
 * pipeline subgraph, terminal-state runs accumulate indefinitely:
 * `host.atoms.query()` pages through every JSON file on FileHost on
 * every tick, and the .lag/atoms/ directory grows unbounded.
 *
 * V0 doctrine (mirrors the plan reaper):
 *   - Atoms are NEVER deleted. The substrate has no deletion verb;
 *     `derived_from` provenance traversal must keep resolving.
 *   - Reaping is a leaf metadata write: `metadata.reaped_at` (ISO from
 *     `host.clock.now()`) + `metadata.reaped_reason` (finite string
 *     discriminator) plus a `confidence: 0.01` floor so arbitration
 *     deprioritizes reaped atoms. The Console projection layer hides
 *     reaped atoms by default with a "Show reaped (N)" toggle.
 *   - Per-atom audit. Each child + the root emits a `pipeline.reaped`
 *     or `pipeline.stage_atom_reaped` audit row carrying the atom id
 *     in `refs.atom_ids`. Volume cost (~25 rows per pipeline reap) is
 *     accepted; collapsing into a single row would lose per-atom-id
 *     references that taint cascades and audit walks need.
 *
 * Pluggability: TTLs are passed in by the caller (driver script,
 * scheduler hook, deployment configuration). Defaults below give safe
 * conservative behavior for unit tests + standalone runs that have not
 * loaded a policy atom. The TTL surface is per-atom-class (terminal
 * pipeline, hil-paused pipeline, agent session) NOT a generic
 * `Map<AtomType, number>`: the reaper enumerates types it knows how to
 * GC. New atom types added without an explicit entry get NO GC
 * (default-safe).
 *
 * Composition: this module is a sibling of `./reaper.ts`, not a
 * replacement. Both reapers compose under one LoopRunner pass; the
 * composition layer is where "this is one logical sweep" lives.
 *
 * What this reaper does NOT do (deferred to follow-ups):
 *   - Hard delete. A future "compactor" task may add an
 *     `AtomStore.archive()` substrate primitive; that is out of scope
 *     here.
 *   - Reap stage outputs whose parent pipeline is still running. The
 *     subgraph reaps atomically when the root crosses TTL; a partial
 *     reap of an in-flight pipeline would break audit walks.
 *   - Reap pipeline-driven plan atoms (the plan-stage's output). Plan
 *     atoms remain the plan reaper's responsibility; coupling the two
 *     would re-introduce the merge-extension problem described in the
 *     spec section 2.
 */

import type { Host } from '../../substrate/interface.js';
import type {
  Atom,
  AtomFilter,
  AtomId,
  AtomType,
  PrincipalId,
  Time,
} from '../../substrate/types.js';

/**
 * TTL configuration for the pipeline reaper, in milliseconds.
 *
 * Per-atom-class scalars rather than a generic `Map<AtomType, number>`
 * because the substrate enumerates the types this reaper handles; an
 * atom type added in the future without a new field on this interface
 * does NOT get GC'd by default. That is intentional: silently reaping
 * a type the operator did not opt into is a worse failure mode than
 * carrying an uncollected type until the operator extends the policy.
 *
 * `terminalPipelineMs` and `agentSessionMs` are the two top-level TTLs;
 * stage-event / stage-output / audit-finding / pipeline-failed /
 * pipeline-resume children cascade-reap atomically when their parent
 * pipeline reaps (their independent TTLs would never fire because
 * those atoms only exist with a parent pipeline). HIL-paused pipelines
 * get a separate, longer TTL so an operator who paused a run for
 * deliberation has weeks rather than days before the run is reaped.
 */
export interface PipelineReaperTtls {
  /**
   * Age threshold for terminal-state pipelines (`completed`, `failed`).
   * Default 30 days. The pipeline atom is GC-eligible once `ageMs >=
   * terminalPipelineMs`; age is computed from `metadata.completed_at`
   * when present, falling back to `last_reinforced_at` and finally
   * `created_at`.
   */
  readonly terminalPipelineMs: number;
  /**
   * Age threshold for `hil-paused` pipelines that never resumed.
   * Default 14 days. A run paused by an HIL gate for two weeks is
   * effectively abandoned; reaping is the substrate's way of saying
   * "this run will not advance, GC its subgraph". An operator who
   * resumes a paused run within the window converts it to running and
   * the TTL no longer applies.
   */
  readonly hilPausedPipelineMs: number;
  /**
   * Age threshold for standalone `agent-session` atoms not derived
   * from any pipeline. Default 30 days. Agent-session atoms produced
   * within a pipeline's stage cascade-reap when the parent pipeline
   * reaps; this TTL only fires on sessions whose `provenance.derived_from`
   * does not chain to a pipeline atom (e.g. PrFix sessions, future
   * standalone agentic adapters).
   */
  readonly agentSessionMs: number;
}

export const DEFAULT_PIPELINE_REAPER_TTLS: PipelineReaperTtls = Object.freeze({
  // 30 days: a pipeline run that completed or failed a month ago is
  // unlikely to be re-investigated; the audit chain is preserved via
  // the leaf metadata write (atoms are not deleted), and the Console
  // projection hides reaped atoms by default. An org-ceiling deployment
  // running tighter retention writes a higher-priority canon policy
  // atom; raising the dial is a deliberate edit, not a code change.
  terminalPipelineMs: 30 * 24 * 60 * 60 * 1000,
  // 14 days: half the terminal TTL. A pipeline paused for HIL review
  // that has not resumed in two weeks is effectively abandoned. The
  // shorter window biases the substrate toward forgetting paused runs
  // sooner so the pipeline-list view does not accumulate stale
  // checkpoints; an operator who actually intends to resume the run
  // takes the action well within the window.
  hilPausedPipelineMs: 14 * 24 * 60 * 60 * 1000,
  // 30 days: matches terminalPipelineMs because the agentic-actor-loop
  // session lifecycle parallels the pipeline run lifecycle. Standalone
  // sessions (PrFix, future agentic adapters not bundled into a
  // pipeline) age on this TTL.
  agentSessionMs: 30 * 24 * 60 * 60 * 1000,
});

/**
 * Fail-fast guard at the framework boundary so a programmatic caller
 * (driver script, scheduler hook, test fixture) cannot pass a non-
 * positive or non-integer TTL and silently skew classification. The
 * driver script also validates env-supplied ms; this guards
 * programmatic calls.
 *
 * Throws on any non-integer or non-positive field.
 */
export function validatePipelineReaperTtls(ttls: PipelineReaperTtls): void {
  const fields: ReadonlyArray<readonly [string, number]> = [
    ['terminalPipelineMs', ttls.terminalPipelineMs],
    ['hilPausedPipelineMs', ttls.hilPausedPipelineMs],
    ['agentSessionMs', ttls.agentSessionMs],
  ];
  for (const [name, value] of fields) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `pipeline-reaper: invalid ${name} (${value}); require positive integer ms`,
      );
    }
  }
}

/**
 * Classification verdict for a pipeline atom. Exposed for unit tests
 * and the driver script's reporting. Non-pipeline atoms classify as
 * `null` (never reaped through this primitive).
 */
export type PipelineReaperVerdict = 'skip' | 'reap';

export interface PipelineReaperClassification {
  readonly atomId: AtomId;
  readonly verdict: PipelineReaperVerdict;
  readonly ageMs: number;
  /**
   * Why the atom was classified the way it was. Rendered into the
   * audit `reason` so operators reading audit history see the
   * concrete signal that triggered the reap. Examples:
   * `'completed-after-30d'`, `'hil-paused-after-14d'`,
   * `'still-running'`, `'recently-completed'`.
   */
  readonly reason: string;
}

/**
 * Pure: classify a single pipeline atom against the TTLs. Returns
 * `null` when the atom is not a pipeline (only pipeline atoms are
 * reaper-eligible at the root level; child atoms are reaped via
 * cascade from their parent pipeline, not via this classifier).
 *
 * Age is resolved from `metadata.completed_at` (preferred -- set by the
 * runner at terminal transition), falling back to `last_reinforced_at`
 * (which the runner stamps at every state change), and finally to
 * `created_at` (the original mint time). The fallback chain matters
 * because a long-running pipeline that was bumped to `running` 30 days
 * after its mint should not classify as stale based on its mint time
 * alone.
 *
 * `nowMs` is epoch milliseconds (whatever the caller resolves from
 * `host.clock.now()` via `Date.parse`); the helper stays unit-pure so
 * tests can pin time without a clock fake.
 */
export function classifyPipelineForReap(
  atom: Atom,
  nowMs: number,
  ttls: PipelineReaperTtls = DEFAULT_PIPELINE_REAPER_TTLS,
): PipelineReaperClassification | null {
  if (atom.type !== 'pipeline') return null;

  const state = atom.pipeline_state;
  // States that are not yet terminal AND not hil-paused are never
  // reap-eligible. A `running` pipeline is in flight; a `pending`
  // pipeline has not started; either is the operator's active surface
  // and reaping it would orphan in-flight stage outputs.
  const isTerminal = state === 'completed' || state === 'failed';
  const isHilPaused = state === 'hil-paused';
  if (!isTerminal && !isHilPaused) {
    return {
      atomId: atom.id,
      verdict: 'skip',
      ageMs: 0,
      reason: `state-not-eligible:${state ?? 'undefined'}`,
    };
  }

  // Resolve the comparison timestamp. completed_at on metadata is
  // preferred when the runner stamped it (terminal transitions write
  // it); otherwise fall back to last_reinforced_at (every transition
  // bumps it) and finally created_at (mint). All three are checked
  // because a malformed metadata.completed_at (non-string, missing,
  // un-parseable) must not silently bypass classification -- Date.parse
  // returning NaN trips the next fallback rather than returning a bad
  // age.
  const meta = atom.metadata as Record<string, unknown>;
  const completedAtRaw = meta['completed_at'];
  let referenceMs = NaN;
  if (typeof completedAtRaw === 'string') {
    referenceMs = Date.parse(completedAtRaw);
  }
  if (!Number.isFinite(referenceMs)) {
    referenceMs = Date.parse(atom.last_reinforced_at);
  }
  if (!Number.isFinite(referenceMs)) {
    referenceMs = Date.parse(atom.created_at);
  }
  if (!Number.isFinite(referenceMs)) {
    // Every fallback failed; the atom's timestamps are corrupt. Treat
    // as not-eligible and surface the reason so a downstream auditor
    // can investigate. Safer than synthesizing an age from `now`.
    return {
      atomId: atom.id,
      verdict: 'skip',
      ageMs: 0,
      reason: 'unparseable-timestamp',
    };
  }

  const ageMs = nowMs - referenceMs;
  if (ageMs < 0) {
    // Future-dated atoms (clock skew) are not stale.
    return {
      atomId: atom.id,
      verdict: 'skip',
      ageMs,
      reason: 'future-dated',
    };
  }

  const threshold = isTerminal ? ttls.terminalPipelineMs : ttls.hilPausedPipelineMs;
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (ageMs >= threshold) {
    const reason = isTerminal
      ? `${state ?? 'terminal'}-after-${ageDays}d`
      : `hil-paused-after-${ageDays}d`;
    return { atomId: atom.id, verdict: 'reap', ageMs, reason };
  }
  return {
    atomId: atom.id,
    verdict: 'skip',
    ageMs,
    reason: isTerminal ? 'recently-terminal' : 'recently-hil-paused',
  };
}

// ---------------------------------------------------------------------------
// Transition primitives
// ---------------------------------------------------------------------------

/**
 * Apply the reaped marker to a pipeline (root) atom. Idempotent: a
 * second call on an already-reaped atom is a no-op (no extra audit row,
 * no extra update). Sets `metadata.reaped_at` + `metadata.reaped_reason`
 * and floors `confidence` to 0.01 so the existing arbitration stack
 * deprioritizes the atom without a separate filter.
 *
 * The audit kind `pipeline.reaped` carries the atom id in
 * `refs.atom_ids` and the prior pipeline_state in `details` so a future
 * audit walk can distinguish "reaped a completed pipeline" from
 * "reaped a still-running pipeline" (which the classifier should never
 * emit, but the audit row is the operator's best signal if it ever
 * does).
 */
export async function markPipelineReaped(
  host: Host,
  atomId: AtomId,
  principalId: PrincipalId,
  reason: string,
): Promise<Atom> {
  const atom = await host.atoms.get(atomId);
  if (!atom) {
    throw new Error(`pipeline atom not found: ${String(atomId)}`);
  }
  if (atom.type !== 'pipeline') {
    throw new Error(`not a pipeline atom: ${String(atomId)}`);
  }
  if ((atom.metadata as Record<string, unknown>)['reaped_at'] !== undefined) {
    // Idempotent: already-reaped, no-op. Returning the existing atom
    // matches the host.atoms.update contract (always returns the
    // post-state atom) so callers do not branch on whether a reap
    // happened or not.
    return atom;
  }
  const now = host.clock.now();
  const updated = await host.atoms.update(atomId, {
    metadata: { reaped_at: now, reaped_reason: reason },
    confidence: 0.01,
  });
  await host.auditor.log({
    kind: 'pipeline.reaped',
    principal_id: principalId,
    timestamp: now,
    refs: { atom_ids: [atomId] },
    details: {
      reason,
      prior_pipeline_state: atom.pipeline_state ?? null,
    },
  });
  return updated;
}

/**
 * Apply the reaped marker to a stage-level (child) atom. Same shape as
 * `markPipelineReaped`, distinguished by audit kind so a single audit
 * walk can isolate root-level reaps from cascade reaps. Accepts any
 * non-`pipeline` atom type that participates in the pipeline subgraph
 * (`pipeline-stage-event`, `pipeline-audit-finding`, `pipeline-failed`,
 * `pipeline-resume`, `brainstorm-output`, `spec-output`, `review-report`,
 * `dispatch-record`, `spec`, `agent-session`, `agent-turn`).
 *
 * Idempotent on a second call (early return when `metadata.reaped_at`
 * is already set).
 */
export async function markStageAtomReaped(
  host: Host,
  atomId: AtomId,
  principalId: PrincipalId,
  reason: string,
): Promise<Atom> {
  const atom = await host.atoms.get(atomId);
  if (!atom) {
    throw new Error(`stage atom not found: ${String(atomId)}`);
  }
  if (atom.type === 'pipeline') {
    // Misuse guard: callers reach for markStageAtomReaped on children
    // and markPipelineReaped on roots. Rejecting the wrong-shape call
    // surfaces the bug at the call site rather than letting the audit
    // log accumulate root-shaped reaps under the stage kind.
    throw new Error(
      `markStageAtomReaped called on a pipeline root atom: ${String(atomId)}`,
    );
  }
  if ((atom.metadata as Record<string, unknown>)['reaped_at'] !== undefined) {
    return atom;
  }
  const now = host.clock.now();
  const updated = await host.atoms.update(atomId, {
    metadata: { reaped_at: now, reaped_reason: reason },
    confidence: 0.01,
  });
  await host.auditor.log({
    kind: 'pipeline.stage_atom_reaped',
    principal_id: principalId,
    timestamp: now,
    refs: { atom_ids: [atomId] },
    details: {
      reason,
      atom_type: atom.type,
    },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Pagination + sweep
// ---------------------------------------------------------------------------

/**
 * Page through every pipeline atom in the store. Mirrors
 * `loadAllProposedPlans` from the plan reaper: paginate with the
 * existing query interface, cap iteration so a runaway store cannot
 * pin memory, and surface a `truncated` flag so the caller knows the
 * slate is partial.
 */
export const PIPELINE_REAPER_PAGE_SIZE = 500;
export const PIPELINE_REAPER_PAGE_LIMIT = 200;

export interface LoadAllTerminalPipelinesResult {
  readonly atoms: ReadonlyArray<Atom>;
  readonly truncated: boolean;
}

/**
 * Load every pipeline atom regardless of state. The classifier filters
 * by state inside `classifyPipelineForReap`; loading every pipeline
 * keeps the query simple and the substrate-side filter shape tight
 * (AtomFilter has no pipeline_state field).
 *
 * Returned atoms are NOT pre-filtered for `metadata.reaped_at`:
 * the classifier + the transition primitives are individually
 * idempotent, so a re-classified already-reaped atom reaches
 * `markPipelineReaped` and short-circuits at the metadata check. The
 * sweep is monotonic: a second pass over the same store does no
 * additional work.
 */
export async function loadAllTerminalPipelines(
  host: Host,
): Promise<LoadAllTerminalPipelinesResult> {
  const filter: AtomFilter = { type: ['pipeline'] };
  const collected: Atom[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PIPELINE_REAPER_PAGE_LIMIT; i++) {
    const page = await host.atoms.query(filter, PIPELINE_REAPER_PAGE_SIZE, cursor);
    for (const a of page.atoms) collected.push(a);
    if (!page.nextCursor) {
      return { atoms: collected, truncated: false };
    }
    cursor = page.nextCursor;
  }
  return { atoms: collected, truncated: true };
}

/**
 * Atom types that participate in the pipeline subgraph. The sweep
 * loads child atoms by `metadata.pipeline_id === pipelineId` filter
 * over this fixed set so a future atom type added without an explicit
 * entry is NOT cascade-reaped (default-safe per the per-atom-class
 * doctrine in `PipelineReaperTtls`).
 *
 * `agent-session` and `agent-turn` are members because their
 * derived_from chains tie back to a pipeline-stage event in the
 * agentic adapter path; they cascade-reap with the parent pipeline.
 * Standalone agent-sessions (no pipeline_id metadata) are reaped on
 * the independent `agentSessionMs` TTL, not via this set.
 */
const SUBGRAPH_CHILD_TYPES: ReadonlyArray<AtomType> = [
  'pipeline-stage-event',
  'pipeline-audit-finding',
  'pipeline-failed',
  'pipeline-resume',
  'brainstorm-output',
  'spec-output',
  'review-report',
  'dispatch-record',
  'spec',
  'agent-session',
  'agent-turn',
];

/**
 * Result of one full sweep. The classifications expose what the
 * sweep saw; the apply result records what actually mutated. Per-atom
 * failures are best-effort (logged + skipped, never thrown) so a
 * single bad atom does not poison the rest of the sweep.
 */
export interface PipelineReapSummary {
  readonly atomId: AtomId;
  readonly atomType: AtomType;
  readonly reason: string;
}

export interface RunPipelineReaperSweepResult {
  readonly classifications: ReadonlyArray<PipelineReaperClassification>;
  readonly reaped: ReadonlyArray<PipelineReapSummary>;
  readonly skipped: ReadonlyArray<{
    readonly atomId: AtomId;
    readonly error: string;
  }>;
  readonly truncated: boolean;
}

/**
 * Walk back through `metadata.pipeline_id === pipelineId` to collect
 * the subgraph children. We use the metadata pointer rather than
 * `derived_from` traversal because `derived_from` is a multi-target
 * array (a stage-event atom typically derives_from `[pipelineId]` but
 * a stage-output atom derives_from `[pipelineId, ...priorOutputIds]`),
 * and the metadata pointer is the substrate-mandated direct lookup
 * key on every pipeline child atom.
 *
 * Returns children grouped so the sweep can apply them in dependency
 * order: leaf atoms first, then the parent. The grouping is a list of
 * lists for clarity; the current invariant is "everything in
 * SUBGRAPH_CHILD_TYPES is a leaf relative to the pipeline root", but
 * if a future cascade adds intermediate nodes the structure
 * accommodates them without a refactor.
 */
async function loadSubgraphChildren(
  host: Host,
  pipelineId: AtomId,
): Promise<ReadonlyArray<Atom>> {
  const filter: AtomFilter = { type: SUBGRAPH_CHILD_TYPES };
  const out: Atom[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PIPELINE_REAPER_PAGE_LIMIT; i++) {
    const page = await host.atoms.query(filter, PIPELINE_REAPER_PAGE_SIZE, cursor);
    for (const a of page.atoms) {
      const meta = a.metadata as Record<string, unknown>;
      if (meta['pipeline_id'] === pipelineId) {
        out.push(a);
      }
      // Some agent-turn atoms thread the session pointer separately;
      // a future schema may carry pipeline_id only on the session, with
      // turns linked via session_atom_id. For the current substrate the
      // turns also carry pipeline_id so this single check covers both.
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

/**
 * One-shot driver: classify + apply across every pipeline. Mirrors
 * `runReaperSweep` from the plan reaper. Validates TTLs, loads every
 * pipeline atom, classifies, and per-pipeline-marked-`reap` walks the
 * subgraph + applies the reaped marker to every child + the root.
 *
 * Best-effort apply: a child failure is logged into `skipped` and the
 * sweep continues. A root failure is logged + the sweep advances to
 * the next pipeline. The classifier and the transition primitives are
 * each individually idempotent so a re-run picks up exactly the work
 * the prior run failed to commit.
 *
 * The kill-switch is checked BEFORE any write (per the
 * `inv-kill-switch-first` canon directive). When the kill-switch is
 * tripped mid-sweep -- between the classifier pass and the apply pass,
 * or between two applies -- the sweep returns the work done so far
 * with `truncated: true` so the caller can surface the early exit.
 *
 * `principalId` is required (no fallback to a hardcoded id per
 * `inv-no-hardcoded-principal-fallback`); the caller resolves the
 * reaper's principal id from env or canon.
 */
export async function runPipelineReaperSweep(
  host: Host,
  principalId: PrincipalId,
  ttls: PipelineReaperTtls = DEFAULT_PIPELINE_REAPER_TTLS,
): Promise<RunPipelineReaperSweepResult> {
  validatePipelineReaperTtls(ttls);

  const rawNow = host.clock.now();
  const nowMs = Date.parse(rawNow);
  if (!Number.isFinite(nowMs)) {
    throw new Error(
      `pipeline-reaper: host.clock.now() returned non-parseable value: ${String(rawNow)}`,
    );
  }

  // Kill-switch first: if tripped before we even start, return empty
  // results rather than attempting any read. The caller decides what
  // to do with an empty sweep when the killswitch is tripped (the
  // LoopRunner's reaperPass treats it as a clean no-op, which is the
  // correct behavior).
  if (host.scheduler.killswitchCheck()) {
    return {
      classifications: [],
      reaped: [],
      skipped: [],
      truncated: true,
    };
  }

  const { atoms, truncated: loadTruncated } = await loadAllTerminalPipelines(host);
  const classifications: PipelineReaperClassification[] = [];
  for (const atom of atoms) {
    const c = classifyPipelineForReap(atom, nowMs, ttls);
    if (c) classifications.push(c);
  }

  const reaped: PipelineReapSummary[] = [];
  const skipped: { atomId: AtomId; error: string }[] = [];
  let truncatedByKillSwitch = false;

  for (const c of classifications) {
    if (c.verdict !== 'reap') continue;
    if (host.scheduler.killswitchCheck()) {
      truncatedByKillSwitch = true;
      break;
    }
    // TOCTOU guard: re-fetch right before apply so a state flip
    // between the classifier pass and now is honored. A pipeline that
    // returned to `running` (e.g. an HIL resume) is no longer
    // reap-eligible and must NOT be marked reaped.
    let fresh: Atom | null;
    try {
      fresh = await host.atoms.get(c.atomId);
    } catch (err) {
      skipped.push({
        atomId: c.atomId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!fresh) {
      skipped.push({ atomId: c.atomId, error: 'atom-disappeared' });
      continue;
    }
    if (fresh.type !== 'pipeline') {
      skipped.push({
        atomId: c.atomId,
        error: `state-changed:not-a-pipeline:${fresh.type}`,
      });
      continue;
    }
    const freshState = fresh.pipeline_state;
    const stillEligible =
      freshState === 'completed'
      || freshState === 'failed'
      || freshState === 'hil-paused';
    if (!stillEligible) {
      skipped.push({
        atomId: c.atomId,
        error: `state-changed:${freshState ?? 'undefined'}`,
      });
      continue;
    }

    // Walk children + reap leaves first, then the root. A child failure
    // is logged into `skipped` and the sweep continues to the next
    // child + the root. This preserves the per-atom audit invariant:
    // a partial-success reap still emits one audit row per child that
    // succeeded, and the operator-visible state matches the audit log.
    let children: ReadonlyArray<Atom>;
    try {
      children = await loadSubgraphChildren(host, c.atomId);
    } catch (err) {
      skipped.push({
        atomId: c.atomId,
        error: `subgraph-load:${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    for (const child of children) {
      if (host.scheduler.killswitchCheck()) {
        truncatedByKillSwitch = true;
        break;
      }
      try {
        const before = (child.metadata as Record<string, unknown>)['reaped_at'];
        await markStageAtomReaped(host, child.id, principalId, c.reason);
        if (before === undefined) {
          // Only count newly-reaped atoms in the summary; idempotent
          // no-ops are not "work done" and would inflate the count if
          // included.
          reaped.push({
            atomId: child.id,
            atomType: child.type,
            reason: c.reason,
          });
        }
      } catch (err) {
        skipped.push({
          atomId: child.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (truncatedByKillSwitch) break;

    // Reap the root last so the audit log ordering reads "leaves
    // first, then root" -- the operator's mental model of a cascade
    // is bottom-up, and the audit row sequence should match.
    try {
      const before = (fresh.metadata as Record<string, unknown>)['reaped_at'];
      await markPipelineReaped(host, c.atomId, principalId, c.reason);
      if (before === undefined) {
        reaped.push({
          atomId: c.atomId,
          atomType: 'pipeline',
          reason: c.reason,
        });
      }
    } catch (err) {
      skipped.push({
        atomId: c.atomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    classifications,
    reaped,
    skipped,
    truncated: loadTruncated || truncatedByKillSwitch,
  };
}
