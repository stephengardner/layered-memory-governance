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
import type { PrObservationRefresher } from '../plans/pr-observation-refresh.js';
import type { PlanProposalNotifier } from '../plans/plan-trigger-telegram.js';
import type {
  OpenPrSource,
  OrphanPrDispatcher,
} from '../plans/pr-orphan-reconcile.js';

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
  // Plan-push-record atoms are per-plan idempotence markers
  // emitted by the LoopRunner notify pass. The half-life is set
  // intentionally LONGER than the proposed-plan reaper window
  // (default 72h) so a long-tail proposed plan does not get
  // re-notified once its push-record decays below the floor; the
  // record's existence is what suppresses the re-push, not its
  // confidence value, but a 1-week half-life keeps the queryable
  // record in the warm set for routine audit reads without growing
  // an AtomType-specific expiry policy on the substrate. The
  // transport name lives in metadata.channel so a single half-life
  // covers every channel.
  'plan-push-record': 7 * 24 * 60 * 60 * 1000,  // ~1 week
  // Operator-intent atoms capture operator directives interactively.
  // They are canonical governance signals with persistence similar to
  // directives; do not decay during the session.
  'operator-intent': 365 * 24 * 60 * 60 * 1000,  // ~1 year
  // Agent-session and agent-turn atoms are audit/replay records of an
  // agentic loop run. Confidence decay does not affect their function
  // (the session/turn lifecycle is single-shot; the metadata is
  // historical), and an active replay debugger may need to read a
  // session months later. A long half-life keeps the records stable
  // during their useful window without growing AtomType-specific
  // expiry policy on the substrate. The 1-year value mirrors
  // `operator-intent` deliberately: both are append-only audit
  // artifacts whose value comes from later forensic re-reading,
  // not from arbitration. Tune them together if at all; operational
  // purge (after N months) lives in a follow-up policy atom.
  'agent-session': 365 * 24 * 60 * 60 * 1000,    // ~1 year
  'agent-turn': 365 * 24 * 60 * 60 * 1000,       // ~1 year
  // Deep planning pipeline atom types. Specs are prose artifacts
  // that may be referenced for months across follow-up work, so
  // their stated confidence stays stable like a directive. Pipeline
  // runtime state, audit projection, and per-stage output atoms
  // (brainstorm-output / spec-output / review-report /
  // dispatch-record) are historical records tied to a specific
  // run; their value comes from later forensic re-reading rather
  // than arbitration, so a long half-life keeps them stable
  // during the useful window. Operational purge after N months
  // belongs in a follow-up policy atom, not on the substrate
  // decay axis.
  spec: 365 * 24 * 60 * 60 * 1000,                       // ~1 year
  'brainstorm-output': 365 * 24 * 60 * 60 * 1000,        // ~1 year
  'spec-output': 365 * 24 * 60 * 60 * 1000,              // ~1 year
  'review-report': 365 * 24 * 60 * 60 * 1000,            // ~1 year
  'dispatch-record': 365 * 24 * 60 * 60 * 1000,          // ~1 year
  pipeline: 365 * 24 * 60 * 60 * 1000,                   // ~1 year
  'pipeline-stage-event': 365 * 24 * 60 * 60 * 1000,     // ~1 year
  'pipeline-audit-finding': 365 * 24 * 60 * 60 * 1000,   // ~1 year
  'pipeline-failed': 365 * 24 * 60 * 60 * 1000,          // ~1 year
  'pipeline-resume': 365 * 24 * 60 * 60 * 1000,          // ~1 year
  // PR-orphan reconciler atoms.
  //
  // Driver-claim atoms carry a 12-hour DEFAULT half-life that matches the
  // dispatcher's `DEFAULT_DRIVER_CLAIM_LIFETIME_MS`. The reconciler treats
  // expired claims as orphaned; if confidence-decay outlives the lifetime
  // contract the claim still nominally exists in arbitration after the
  // dispatcher has given up on it, drifting the two views apart. Keeping
  // them aligned removes the foot-gun.
  //
  // Orphan-detected atoms are append-only audit records tied to a specific
  // in-flight PR; their value comes from later forensic re-reading rather
  // than arbitration. A long half-life keeps the stated confidence stable
  // during the useful window without polluting the substrate decay axis.
  // Operational purge after N months belongs in a follow-up policy atom;
  // mirrors the agent-session / agent-turn / plan-merge-settled posture.
  'pr-driver-claim': 12 * 60 * 60 * 1000,                 // 12 hours
  'pr-orphan-detected': 365 * 24 * 60 * 60 * 1000,        // ~1 year
  // Zero-failure sub-agent substrate atoms.
  //
  // Work-claim atoms are in-flight contracts whose existence drives the
  // reaper and the `markClaimComplete` gate; once the lifecycle reaches
  // a terminal state the atom is historical-record material. A long
  // half-life keeps stated confidence stable during the useful window
  // (in-flight + post-terminal forensic re-read); operational purge
  // after N months belongs in a follow-up policy atom. The 1-year
  // value mirrors the agent-session / pr-orphan-detected posture.
  //
  // Attestation, stall, and escalation atoms are append-only audit
  // records derived from a specific work-claim's history; same long
  // half-life so the audit chain stays queryable without growing an
  // AtomType-specific expiry policy on the substrate.
  'work-claim': 365 * 24 * 60 * 60 * 1000,                  // ~1 year
  'claim-attestation-accepted': 365 * 24 * 60 * 60 * 1000,  // ~1 year
  'claim-attestation-rejected': 365 * 24 * 60 * 60 * 1000,  // ~1 year
  'claim-stalled': 365 * 24 * 60 * 60 * 1000,               // ~1 year
  'claim-escalated': 365 * 24 * 60 * 60 * 1000,             // ~1 year
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
  /**
   * Run the stale-plan reaper as part of every tick. Default `false`
   * so existing callers and test harnesses observe no behavior change.
   * Long-running deployments that want plan-state cleanup to self-
   * sustain enable this from the CLI flag (`--reap-stale-plans`) or
   * pass it directly when wiring a custom runner.
   *
   * When enabled, `reaperPrincipal` is required (validated at
   * constructor time); the reaper uses it to attribute every audit
   * row produced by a `proposed -> abandoned` transition.
   */
  readonly runReaperPass?: boolean;
  /**
   * Principal id the reaper attributes its abandonment transitions
   * to. Required when `runReaperPass: true`; ignored otherwise. The
   * value is validated against the host's PrincipalStore on the
   * first reaper pass so a typo (or a fresh deployment that has not
   * provisioned the principal) fails loud rather than producing an
   * audit row attributed to a non-existent identity.
   */
  readonly reaperPrincipal?: string;
  /**
   * Override the warn-bucket TTL for the reaper, in milliseconds.
   * Defaults to `DEFAULT_REAPER_TTLS.staleWarnMs` from the reaper
   * module. Validated as a positive integer when supplied.
   */
  readonly reaperWarnMs?: number;
  /**
   * Override the abandon-bucket TTL for the reaper, in milliseconds.
   * Defaults to `DEFAULT_REAPER_TTLS.staleAbandonMs` from the reaper
   * module. Validated as a positive integer greater than the warn
   * threshold when supplied.
   */
  readonly reaperAbandonMs?: number;
  /**
   * Override the terminal-pipeline TTL for the pipeline reaper, in
   * milliseconds. Defaults to
   * `DEFAULT_PIPELINE_REAPER_TTLS.terminalPipelineMs`. Validated as a
   * positive integer when supplied. Mirrors the env-override surface
   * the driver script reads from `LAG_PIPELINE_REAPER_TERMINAL_MS`,
   * just promoted into the runner constructor so a misconfigured
   * wiring fails the boot path rather than producing one bad sweep.
   * Used only when `runReaperPass: true`.
   */
  readonly pipelineReaperTerminalMs?: number;
  /**
   * Override the hil-paused-pipeline TTL for the pipeline reaper, in
   * milliseconds. Defaults to
   * `DEFAULT_PIPELINE_REAPER_TTLS.hilPausedPipelineMs`. Mirrors the
   * driver's `LAG_PIPELINE_REAPER_HIL_PAUSED_MS` env knob.
   */
  readonly pipelineReaperHilPausedMs?: number;
  /**
   * Override the standalone-agent-session TTL for the pipeline
   * reaper, in milliseconds. Defaults to
   * `DEFAULT_PIPELINE_REAPER_TTLS.agentSessionMs`. Mirrors the
   * driver's `LAG_PIPELINE_REAPER_AGENT_SESSION_MS` env knob.
   */
  readonly pipelineReaperAgentSessionMs?: number;
  /**
   * Run the plan-state reconcile pass on every tick. Default `false`
   * so existing callers observe no behavior change. When enabled,
   * transitions plans whose linked pr-observation atoms carry a
   * terminal pr_state from 'executing' / 'approved' to
   * 'succeeded' / 'abandoned'.
   *
   * The pass is in-process: scans observation atoms via the host's
   * AtomStore and writes plan transitions through the host. Cost
   * scales with the count of pr-observation atoms, bounded inside
   * the tick by `maxScan` (default 5000).
   */
  readonly runPlanReconcilePass?: boolean;
  /**
   * Run the pr-observation refresh pass on every tick. Default
   * `false`. When the flag is true and `prObservationRefresher` is
   * supplied, the pass refreshes pr-observation atoms whose
   * pr_state is non-terminal, whose linked Plan is still executing,
   * and whose observed_at age exceeds the freshness threshold (read
   * from canon `pol-pr-observation-freshness-threshold-ms`, default
   * 5 minutes). Per-tick refresh count is bounded inside the tick
   * (default 50).
   *
   * When the flag is true but `prObservationRefresher` is absent,
   * the pass silently skips and logs once per tick. This permits
   * the reconcile pass to run alone on deployments where terminal
   * observations are written by an external driver. A constructor-
   * time throw would forbid that posture and is wrong for a
   * mechanism-only API.
   *
   * Sequencing: when both passes are enabled, the refresh pass runs
   * first within a tick so a stale non-terminal observation
   * rewritten to terminal state by the refresher is reconciled on
   * the SAME tick (not next pass).
   */
  readonly runPlanObservationRefreshPass?: boolean;
  /**
   * Pluggable adapter the refresh tick calls when an observation
   * needs to be re-observed. Optional; absent activates the silent-
   * skip path documented on `runPlanObservationRefreshPass`. The
   * framework consumes the adapter only through the
   * `PrObservationRefresher` interface; concrete adapter
   * construction happens entirely outside framework code.
   */
  readonly prObservationRefresher?: PrObservationRefresher;
  /**
   * Run the plan-proposal notify pass on every tick. Default
   * `false`. When the flag is true and `planProposalNotifier` is
   * supplied, the pass scans proposed plan atoms whose principal
   * is in the canon-defined allowlist (carried by the
   * `telegram-plan-trigger-principals` policy subject; the
   * framework default lives in DEFAULT_PRINCIPAL_ALLOWLIST and
   * applies when no policy atom resolves), calls the notifier
   * exactly once per plan, and writes a `plan-push-record`
   * atom to make the push idempotent across re-ticks.
   *
   * When the flag is true but `planProposalNotifier` is absent,
   * the pass silent-skips and warns once per runner. This permits
   * a deployment to opt into the flag from canon while wiring the
   * notifier seam later (or a sandboxed deployment to disable
   * outbound notifications entirely without removing the canon-
   * side configuration).
   */
  readonly runPlanProposalNotifyPass?: boolean;
  /**
   * Pluggable adapter the notify tick calls when a proposed plan
   * needs to be pushed to the operator. Optional; absent activates
   * the silent-skip path. The framework consumes the adapter only
   * through the `PlanProposalNotifier` interface; concrete
   * construction happens entirely outside framework code.
   */
  readonly planProposalNotifier?: PlanProposalNotifier;
  /**
   * Principal id the notify tick attributes its
   * `plan-push-record` atoms to. Optional; defaults to the
   * loop's `principalId` when omitted -- the record is operational
   * data the loop is recording about its own action. Override when
   * a deployment wants the audit chain to attribute the push to a
   * dedicated push-bot identity.
   */
  readonly planProposalNotifyPrincipal?: string;
  /**
   * Run the PR-orphan reconcile pass on every tick. Default `false`
   * so existing callers observe no behavior change. When the flag
   * is true and BOTH `prOpenPrSource` and `prOrphanDispatcher` are
   * supplied, the pass walks open PRs, joins each with the active
   * `pr-driver-claim` atom, and detects orphans (no claim + stale
   * activity, claim expired, or claimant inactive). On detection
   * the pass emits a `pr-orphan-detected` atom and asks the
   * dispatcher to spawn a fresh driver sub-agent.
   *
   * When the flag is true but either seam is absent, the pass
   * silently skips and logs once per runner. This matches the
   * `runPlanObservationRefreshPass` posture: an enabling caller
   * may opt into the flag from canon while wiring the seams in
   * a follow-up.
   *
   * Cost: one `OpenPrSource.list()` call per tick plus
   * O(open-PR-count) atom queries. Bounded by `maxDispatchPerTick`
   * inside the tick (default 5) so a sudden orphan surge does not
   * stampede the dispatcher.
   */
  readonly runPrOrphanReconcilePass?: boolean;
  /**
   * Pluggable seam supplying the set of open PRs to reconcile.
   * Required when `runPrOrphanReconcilePass: true`; absent, the
   * silent-skip path activates. The framework consumes the seam
   * through the `OpenPrSource` interface; concrete construction
   * happens entirely outside framework code.
   */
  readonly prOpenPrSource?: OpenPrSource;
  /**
   * Pluggable seam dispatching a fresh driver sub-agent on orphan
   * detection. Required when `runPrOrphanReconcilePass: true`;
   * absent, the silent-skip path activates. The framework consumes
   * the seam through the `OrphanPrDispatcher` interface; concrete
   * construction happens entirely outside framework code.
   */
  readonly prOrphanDispatcher?: OrphanPrDispatcher;
  /**
   * Override the orphan-detection threshold (ms) for tests / tight-
   * cadence runs. When omitted, the threshold is read from canon
   * `pol-pr-orphan-reconcile-threshold-ms` (default 5 minutes).
   * Must be a positive integer; validated at construction time when
   * the pass is enabled.
   */
  readonly prOrphanThresholdMs?: number;
  /**
   * Override the per-tick dispatch budget for orphan detection.
   * Default 5; deployments may raise via canon. Must be a positive
   * integer when supplied.
   */
  readonly prOrphanMaxDispatchPerTick?: number;
  /**
   * Run the claim-reaper pass on every tick. Default `false` so
   * existing callers observe no behavior change (indie-floor opt-in
   * per the zero-failure-sub-agent-substrate spec Section 13). When
   * enabled, each tick invokes `runClaimReaperTick(host)` which
   * detects stalled work-claim atoms (Phase A) and drives them
   * through the bounded recovery ladder (Phase B).
   *
   * Resolution chain (highest to lowest precedence):
   *   1. canon `pol-loop-pass-claim-reaper-default` policy atom
   *      (re-read every tick so an operator edit takes effect on the
   *      next pass without a daemon restart)
   *   2. `LoopOptions.runClaimReaperPass` (this field; CLI / env)
   *   3. hardcoded default `false`
   *
   * The pass is mechanism-only at this layer: the claim-reaper module
   * already reads its own canon policies (cadence, grace windows,
   * recovery cap, deadline extension, budget tier ladder). A pass
   * failure logs to `errors` but does NOT fail the tick: the claim
   * reaper is best-effort cleanup and one aborted sweep should not
   * stall the rest of the loop's responsibilities.
   */
  readonly runClaimReaperPass?: boolean;
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
  /**
   * Per-tick reaper summary. `null` when the reaper pass is disabled
   * (the default). When enabled, populated with the bucket counts
   * from the sweep: `swept` is the total count of plans the reaper
   * looked at, `abandoned` is the count of `proposed -> abandoned`
   * transitions actually applied, `warned` is the count of plans in
   * the warn bucket (>= warnMs but < abandonMs), and `fresh` is the
   * count of plans whose age stayed under the warn threshold.
   *
   * A reaper internal failure logs to `errors` but leaves
   * `reaperReport` set to `null` for that tick - the field is the
   * positive signal of a successful pass, not a status flag.
   */
  readonly reaperReport:
    | {
        readonly swept: number;
        readonly abandoned: number;
        readonly warned: number;
        readonly fresh: number;
      }
    | null;
  /**
   * Per-tick plan-state reconcile summary. `null` when the reconcile
   * pass is disabled (the default). When enabled, populated with the
   * tick's counts: `scanned` is the total pr-observation atoms
   * inspected, `matched` is observations that linked to a plan and
   * carried terminal pr_state, `transitioned` is plans actually
   * flipped this tick, and `claimConflicts` is observations skipped
   * because a prior tick (or another worker) already wrote the
   * settle marker.
   *
   * A reconcile failure logs to `errors` and leaves
   * `planReconcileReport` set to `null`; the field is the positive
   * signal of a successful pass, not a status flag.
   */
  readonly planReconcileReport:
    | {
        readonly scanned: number;
        readonly matched: number;
        readonly transitioned: number;
        readonly claimConflicts: number;
      }
    | null;
  /**
   * Per-tick pr-observation refresh summary. `null` when the refresh
   * pass is disabled OR when the pass is enabled but the refresher
   * seam is absent (the silent-skip path; the operator sees the gap
   * via the once-per-tick log line, not via this field). When the
   * pass actually runs, populated with `scanned` (observations
   * inspected), `refreshed` (refresher.refresh calls succeeded),
   * and `skipped` (a histogram of skip reasons including 'fresh',
   * 'plan-not-executing', 'rate-limited', 'refresh-failed', etc.).
   */
  readonly planObservationRefreshReport:
    | {
        readonly scanned: number;
        readonly refreshed: number;
        readonly skipped: Readonly<Record<string, number>>;
      }
    | null;
  /**
   * Per-tick plan-proposal notify summary. `null` when the pass is
   * disabled OR when the pass is enabled but the notifier seam is
   * absent (the silent-skip path; the operator sees the gap via
   * the once-per-runner log line, not via this field). When the
   * pass actually runs, populated with `scanned` (proposed plans
   * inspected), `notified` (notifier.notify calls succeeded + record
   * written), and `skipped` (a histogram of skip reasons including
   * 'already-pushed', 'not-in-allowlist', 'notify-failed',
   * 'rate-limited', 'tainted', 'superseded',
   * 'record-write-failed').
   */
  readonly planProposalNotifyReport:
    | {
        readonly scanned: number;
        readonly notified: number;
        readonly skipped: Readonly<Record<string, number>>;
      }
    | null;
  /**
   * Per-tick pr-orphan reconcile summary. `null` when the pass is
   * disabled OR when the pass is enabled but a required seam
   * (`prOpenPrSource`, `prOrphanDispatcher`) is absent (the silent-
   * skip path). When the pass actually runs, populated with
   * `scanned` (open PRs inspected), `orphansDetected` (orphan-
   * detected atoms emitted this tick), `dispatched` (fresh driver
   * dispatches that succeeded), and `skipped` (a histogram of skip
   * reasons including 'no-claim-but-fresh', 'claim-active',
   * 'idempotent-skip', 'rate-limited', etc.).
   */
  readonly prOrphanReconcileReport:
    | {
        readonly scanned: number;
        readonly orphansDetected: number;
        readonly idempotentSkips: number;
        readonly dispatched: number;
        readonly failedDispatches: number;
        readonly rateLimited: number;
        readonly skipped: Readonly<Record<string, number>>;
      }
    | null;
  /**
   * Per-tick pipeline-reaper sweep summary. `null` when the reaper
   * pass is disabled (the default) OR when the pipeline reaper itself
   * fails (its error logs to `errors[]` and the field stays null --
   * the field is the positive signal of a successful pipeline-reaper
   * sweep, not a status flag, and a plan-reaper failure does NOT
   * cascade into this field).
   *
   * `classified` is the count of pipeline atoms the sweep inspected,
   * `reaped` is the count of leaf-write reap markers actually
   * applied this tick (including stage-atom children + the root),
   * `skipped` is the count of per-atom errors collected during apply
   * (each one logged through the auditor inside the sweep but not
   * thrown so a single bad child does not stall the sweep), and
   * `truncated` flags pagination overflow OR a kill-switch trip
   * mid-sweep so the operator can re-run for the remainder.
   */
  readonly pipelineReaperReport:
    | {
        readonly classified: number;
        readonly reaped: number;
        readonly skipped: number;
        readonly truncated: boolean;
      }
    | null;
  /**
   * Per-tick claim-reaper summary. `null` when the claim-reaper pass
   * is disabled (the default) OR when the claim reaper itself
   * fails (its error logs to `errors[]` and the field stays null --
   * the field is the positive signal of a successful claim-reaper
   * pass, not a status flag).
   *
   * `detected` is the count of work-claim atoms the Phase A scan
   * transitioned to `stalled` this tick, `recovered` is the count of
   * stalled claims the Phase B drain successfully recovered
   * (state -> executing), and `escalated` is the count of stalled
   * claims that exceeded the recovery cap and were abandoned with a
   * `claim-stuck` Event telegraphed. `halted` is set true when the
   * reaper exited at its own STOP-sentinel check (`.lag/STOP` armed
   * during the tick); set to `undefined` otherwise so the JSON
   * output is one-line cleaner on the common case.
   */
  readonly claimReaperReport:
    | {
        readonly detected: number;
        readonly recovered: number;
        readonly escalated: number;
        readonly halted?: boolean;
      }
    | null;
}

export interface LoopStats {
  readonly totalTicks: number;
  readonly totalErrors: number;
  readonly lastTick: LoopTickReport | null;
  readonly running: boolean;
}
