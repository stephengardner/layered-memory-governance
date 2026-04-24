/**
 * Self-loop types.
 *
 * The self-loop is the autonomous primitive: a periodic tick that walks the
 * store, decays confidence, runs promotion passes, and applies approved
 * canon proposals to disk. It is what turns LAG from a library into a live
 * long-running system.
 */

import type { AtomFilter, AtomType, Time } from '../../types.js';
import type { RenderOptions } from '../../canon-md/index.js';
import type { PromotionThresholds } from '../../promotion/index.js';

export interface HalfLifeConfig {
  /** Per-atom-type half-life in milliseconds. `directive` long, `ephemeral` short. */
  readonly [type: string]: number;
}

export const DEFAULT_HALF_LIVES: Readonly<Record<AtomType, number>> = Object.freeze({
  directive: 365 * 24 * 60 * 60 * 1000,   // ~1 year
  decision: 120 * 24 * 60 * 60 * 1000,    // ~4 months
  preference: 180 * 24 * 60 * 60 * 1000,  // ~6 months
  observation: 60 * 24 * 60 * 60 * 1000,  // ~2 months
  reference: 90 * 24 * 60 * 60 * 1000,    // ~3 months
  ephemeral: 7 * 24 * 60 * 60 * 1000,     // ~1 week
  // Plans do not decay on the confidence axis; they terminate via
  // their own state machine (proposed -> approved -> executing ->
  // succeeded / failed / abandoned). A very long half-life keeps the
  // plan's stated confidence essentially untouched during its lifetime.
  plan: 365 * 24 * 60 * 60 * 1000,        // ~1 year
  // Questions do not decay; they terminate via the question_state
  // machine (pending -> answered | expired | abandoned). A long
  // half-life keeps stated confidence stable during their lifetime.
  question: 365 * 24 * 60 * 60 * 1000,    // ~1 year
  // Inbox V1 runtime atoms. These are transient records of sends, acks,
  // trips, and resets -- operational data, not canon. Short half-lives
  // so the atom store does not accumulate stale inbox traffic. Final
  // TTL policy is an operational tuning concern that can move to an
  // explicit policy atom in a follow-up; 7 days matches the existing
  // `ephemeral` floor.
  'actor-message': 7 * 24 * 60 * 60 * 1000,         // ~1 week
  'actor-message-ack': 7 * 24 * 60 * 60 * 1000,     // ~1 week
  // Trips and resets are audit evidence; retained longer so a
  // postmortem on a runaway sender can still see the trip + reset
  // pair after a few months.
  'circuit-breaker-trip': 180 * 24 * 60 * 60 * 1000,   // ~6 months
  'circuit-breaker-reset': 180 * 24 * 60 * 60 * 1000,  // ~6 months
  // Plan-approval votes are process signals attached to a specific
  // plan, not decaying canonical facts. The plan-approval pass
  // enforces its own freshness via max_age_ms; decay is irrelevant
  // for the authority grant, so a long half-life keeps the vote's
  // stated confidence stable during the approval window.
  'plan-approval-vote': 180 * 24 * 60 * 60 * 1000,  // ~6 months
  // Plan-merge-settled markers are per-PR-merge-per-plan historical
  // records; they tie a plan to its terminal PR outcome. Confidence
  // decay is irrelevant for a historical record.
  'plan-merge-settled': 365 * 24 * 60 * 60 * 1000,  // ~1 year
});

export interface LoopOptions {
  /** Minimum confidence floor; atoms never drop below this. Default 0.01. */
  readonly minConfidence?: number;
  /** Per-type half-lives (ms). Defaults to DEFAULT_HALF_LIVES. */
  readonly halfLives?: Readonly<Record<AtomType, number>>;
  /** Whether to run the TTL expiration pass on each tick. Default true. */
  readonly runTtlPass?: boolean;
  /** Whether to run the L2 promotion pass on each tick. Default true. */
  readonly runL2Promotion?: boolean;
  /** Whether to run the L3 promotion pass on each tick. Default true. */
  readonly runL3Promotion?: boolean;
  /** Whether to scan for approved L3 proposals and apply canon. Default true. */
  readonly runCanonApplier?: boolean;
  /** Principal the loop acts under. */
  readonly principalId: string;
  /** Max atoms to process per tick (cost ceiling). Default 1000. */
  readonly maxAtomsPerTick?: number;
  /**
   * Timeout for the L3 human-approval gate, in ms. Default 250 (short, to
   * keep ticks responsive). Callers running interactive human flows should
   * raise this to match their human-response SLA.
   */
  readonly l3HumanGateTimeoutMs?: number;
  /**
   * Override the promotion thresholds threaded into both the L2 and L3
   * engines. Defaults to the substrate-wide `DEFAULT_THRESHOLDS`, which
   * requires `validation === 'verified'` on the L3 path. Tests and
   * zero-config bootstrapping paths that don't have a
   * `ValidatorRegistry` wired can override with
   * `{ L3: { ..., requireValidation: false } }`.
   */
  readonly promotionThresholds?: PromotionThresholds;
  /**
   * Single-target canon (legacy, still supported). If set, the runner
   * renders all non-superseded L3 atoms into this file's bracketed
   * section. Ignored when `canonTargets` is also set.
   */
  readonly canonTargetPath?: string;
  /** Max L3 atoms to render into the single canon target. Default 500. */
  readonly canonMaxAtoms?: number;
  /**
   * Multi-target canon. Each target renders a scope- or principal-
   * filtered view of L3 atoms into its own bracketed section.
   *
   * Enables the autonomous-organization pattern where an org-wide
   * CLAUDE.md, a team CLAUDE.md, and an individual-agent CLAUDE.md
   * each receive only the atoms relevant to their layer of the
   * principal hierarchy. See `design/target-architecture.md`.
   *
   * When set, `canonTargetPath` / `canonMaxAtoms` are ignored; if you
   * still want a global default, include it as the first `canonTargets`
   * entry with no filter.
   */
  readonly canonTargets?: ReadonlyArray<CanonTarget>;
  /**
   * Optional callback invoked after every tick() completes. Receives the
   * tick report. CLIs and monitors use this to stream progress.
   */
  readonly onTick?: (report: LoopTickReport) => void | Promise<void>;
}

/**
 * One canon render target. Each `CanonTarget` gets its own
 * `CanonMdManager` under the hood; the loop tick renders all of them
 * in the order declared.
 */
export interface CanonTarget {
  /** Path to the target markdown file. Created if absent. */
  readonly path: string;
  /**
   * AtomFilter applied to the L3 atom set before rendering into this
   * target. Common uses: `{ scope: ['global'] }` for an org-wide canon,
   * `{ scope: ['project'], principal_id: [teamLeadId] }` for a team-
   * led canon, `{ ids: [specificAtomIds] }` for a curated subset.
   * Default: no additional filter beyond `{ layer: ['L3'] }` applied
   * automatically by the runner.
   */
  readonly filter?: AtomFilter;
  /** Max atoms to render into this target. Default 500. */
  readonly maxAtoms?: number;
  /** Per-target render options (e.g. hide confidence, custom "now"). */
  readonly renderOptions?: RenderOptions;
}

export interface LoopTickReport {
  readonly tickNumber: number;
  readonly startedAt: Time;
  readonly finishedAt: Time;
  readonly killSwitchTriggered: boolean;
  readonly atomsDecayed: number;
  readonly atomsExpired: number;
  readonly l2Promoted: number;
  readonly l2Rejected: number;
  readonly l3Proposed: number;
  readonly canonApplied: number;
  readonly errors: ReadonlyArray<string>;
}

export interface LoopStats {
  readonly totalTicks: number;
  readonly totalErrors: number;
  readonly lastTick: LoopTickReport | null;
  readonly running: boolean;
}
