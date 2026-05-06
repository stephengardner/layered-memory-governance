/**
 * LoopRunner: the autonomous-system tick.
 *
 * One `tick()` walks the host through:
 *   1. STOP-file (kill-switch) check. If armed, report and bail.
 *   2. Decay pass: recompute confidence for all non-superseded atoms at
 *      L0 and L1 against their type's half-life and last_reinforced_at.
 *      Only persist when the change exceeds epsilon (quiet small noise).
 *   3. L2 promotion pass: find consensus content-hash groups at L1,
 *      promote the representative to L2 per policy.
 *   4. L3 promotion pass: find consensus groups at L2, promote to L3
 *      (which telegraphs a human gate per DEFAULT_THRESHOLDS).
 *   5. Canon applier: not yet wired here (Phase 10.5); approved L3
 *      proposals are picked up by the canon-md module's own applier.
 *
 * Tests drive `tick()` directly. Long-running mode is `start(intervalMs)`
 * backed by the host's Scheduler + defer chain. `stop()` halts.
 */

import type { Host } from '../../interface.js';
import type { Atom, AtomType, PrincipalId, Time } from '../../types.js';
import {
  PromotionEngine,
  type PromotableLayer,
  type PromotionOutcome,
} from '../../promotion/index.js';
import { CanonMdManager, type RenderOptions } from '../../canon-md/index.js';
import { decayedConfidence, shouldUpdateConfidence } from './decay.js';
import { ttlExpirePatch } from './ttl.js';
import {
  DEFAULT_HALF_LIVES,
  type CanonTarget,
  type LoopOptions,
  type LoopStats,
  type LoopTickReport,
} from './types.js';
import type { AtomFilter } from '../../types.js';
import {
  DEFAULT_REAPER_TTLS,
  runReaperSweep,
  type ReaperTtls,
  type RunReaperSweepResult,
} from '../plans/reaper.js';
import { readReaperTtlsFromCanon } from './reaper-ttls.js';
import {
  runPlanStateReconcileTick,
  type PlanReconcileTickResult,
} from '../plans/pr-merge-reconcile.js';
import {
  runPlanObservationRefreshTick,
  type PlanObservationRefreshResult,
  type PrObservationRefresher,
} from '../plans/pr-observation-refresh.js';
import {
  runPlanProposalNotifyTick,
  type PlanProposalNotifier,
  type PlanProposalNotifyResult,
} from '../plans/plan-trigger-telegram.js';

/**
 * A canon target after resolution: the manager is instantiated, and the
 * filter has been merged with the mandatory `{ layer: ['L3'] }` clause.
 */
interface ResolvedCanonTarget {
  readonly manager: CanonMdManager;
  readonly atomFilter: AtomFilter;
  readonly maxAtoms: number;
  readonly renderOptions: RenderOptions | undefined;
}

export class LoopRunner {
  private readonly options: Required<
    Pick<
      LoopOptions,
      | 'minConfidence'
      | 'halfLives'
      | 'runTtlPass'
      | 'runL2Promotion'
      | 'runL3Promotion'
      | 'runCanonApplier'
      | 'principalId'
      | 'maxAtomsPerTick'
      | 'l3HumanGateTimeoutMs'
      | 'runReaperPass'
      | 'runPlanReconcilePass'
      | 'runPlanObservationRefreshPass'
      | 'runPlanProposalNotifyPass'
    >
  >;
  private readonly l2Engine: PromotionEngine;
  private readonly l3Engine: PromotionEngine;
  private readonly canonTargets: ReadonlyArray<ResolvedCanonTarget>;
  private readonly onTick: ((report: LoopTickReport) => void | Promise<void>) | null;
  private readonly reaperPrincipal: PrincipalId | null;
  /**
   * Constructor-validated env / CLI fallback for the reaper TTL pair.
   * The actual TTLs used per tick come from `resolveReaperTtls`, which
   * checks canon first and falls through here on absence / malformed.
   * Holding the env-derived pair separately keeps the canon path
   * additive: existing flag + env wiring keeps working as-is while the
   * policy atom is the org-tunable dial above it.
   */
  private readonly reaperEnvTtls: ReaperTtls;
  /**
   * `true` when the env-derived pair was supplied explicitly via
   * `LoopOptions.reaperWarnMs` / `reaperAbandonMs` (CLI flag or env
   * var). When `false`, the env-pair equals `DEFAULT_REAPER_TTLS` and
   * the per-tick log labels the source as `defaults` so the operator
   * can see the loop is using the floor, not a deliberate override.
   */
  private readonly reaperEnvOverride: boolean;
  /**
   * `null` means we have not yet checked the principal exists in the
   * host's PrincipalStore. We defer the lookup to the first reaper
   * pass (vs. failing in the constructor) because the constructor
   * is sync; once the lookup runs we cache the result so subsequent
   * ticks do not re-hit the store.
   */
  private reaperPrincipalChecked: boolean = false;
  /**
   * Refresher seam for the pr-observation refresh pass. `null` when
   * the pass is disabled OR when the caller did not wire a refresher
   * (the silent-skip path). The framework consumes the adapter only
   * through the `PrObservationRefresher` interface; concrete
   * construction happens outside framework code.
   */
  private readonly prObservationRefresher: PrObservationRefresher | null;
  /**
   * Latch for the once-per-runner gap-warning when the refresh pass
   * is enabled but no refresher seam was supplied. Daemons can run
   * for days; the warning fires on the FIRST silent-skip tick only,
   * subsequent ticks stay quiet so a misconfigured run does not
   * flood stderr. Reset is implicit on runner re-construction.
   */
  private warnedMissingRefresher: boolean = false;
  /**
   * Notifier seam for the plan-proposal notify pass. `null` when
   * the pass is disabled OR when the caller did not wire a
   * notifier (the silent-skip path). The framework consumes the
   * adapter only through the `PlanProposalNotifier` interface;
   * concrete construction happens outside framework code.
   */
  private readonly planProposalNotifier: PlanProposalNotifier | null;
  /**
   * Resolved principal id the notify pass attributes its
   * idempotence-record atoms to. Defaults to the loop's
   * `principalId` when no explicit override is supplied; resolved
   * once at construction so a misconfigured override fails loud
   * during boot rather than producing audit rows attributed to a
   * fallback identity.
   */
  private readonly planProposalNotifyPrincipal: PrincipalId;
  /**
   * Latch for the once-per-runner gap-warning when the notify pass
   * is enabled but no notifier seam was supplied. Mirrors
   * `warnedMissingRefresher` to keep stderr clean across long-
   * running daemons.
   */
  private warnedMissingNotifier: boolean = false;
  private tickCounter: number = 0;
  private errorCounter: number = 0;
  private lastReport: LoopTickReport | null = null;
  private running: boolean = false;
  private cancelNextTimer: (() => void) | null = null;

  constructor(
    private readonly host: Host,
    options: LoopOptions,
  ) {
    this.options = {
      minConfidence: options.minConfidence ?? 0.01,
      halfLives: options.halfLives ?? DEFAULT_HALF_LIVES,
      runTtlPass: options.runTtlPass ?? true,
      runL2Promotion: options.runL2Promotion ?? true,
      runL3Promotion: options.runL3Promotion ?? true,
      runCanonApplier: options.runCanonApplier ?? true,
      principalId: options.principalId,
      maxAtomsPerTick: options.maxAtomsPerTick ?? 1000,
      l3HumanGateTimeoutMs: options.l3HumanGateTimeoutMs ?? 250,
      runReaperPass: options.runReaperPass ?? false,
      runPlanReconcilePass: options.runPlanReconcilePass ?? false,
      runPlanObservationRefreshPass: options.runPlanObservationRefreshPass ?? false,
      runPlanProposalNotifyPass: options.runPlanProposalNotifyPass ?? false,
    };
    // Capture the refresher seam at construction time. Storing here
    // (vs. reading off `options` per tick) keeps the per-tick path
    // free of optional-property reads on the caller's options
    // object. The pass silent-skips when this is null; the
    // construction-time path does not throw because a caller
    // opting into the refresh flag without supplying a refresher
    // may be a coherent choice (see `runPlanObservationRefreshPass`
    // doc on LoopOptions).
    this.prObservationRefresher = options.prObservationRefresher ?? null;
    // Capture the notify seam + principal at construction time so
    // the per-tick path is free of optional-property reads on the
    // caller's options object. The pass silent-skips when the
    // notifier is null. The principal defaults to the loop's
    // principalId when no override is supplied; this keeps
    // attribution consistent with the rest of the loop's audit
    // rows by default and lets a deployment override only when it
    // wants a dedicated push-bot identity. Validate non-empty
    // (mirrors the reaperPrincipal guard) so a misconfigured
    // wiring fails the boot path rather than producing audit rows
    // attributed to an empty principal id.
    this.planProposalNotifier = options.planProposalNotifier ?? null;
    const rawNotifyPrincipal = options.planProposalNotifyPrincipal ?? options.principalId;
    if (typeof rawNotifyPrincipal !== 'string' || rawNotifyPrincipal.trim().length === 0) {
      throw new Error(
        'LoopRunner: planProposalNotifyPrincipal (or principalId fallback) must be a non-empty string',
      );
    }
    this.planProposalNotifyPrincipal = rawNotifyPrincipal as PrincipalId;
    // Validate the reaper config at construction time (vs. first
    // tick) so a misconfigured wiring fails the boot-up path instead
    // of silently producing one bad tick. Validation is gated on
    // `runReaperPass` so existing callers paying nothing for the
    // feature observe no behavior change.
    if (this.options.runReaperPass) {
      const rp = options.reaperPrincipal;
      if (typeof rp !== 'string' || rp.trim().length === 0) {
        throw new Error(
          'LoopRunner: runReaperPass=true requires reaperPrincipal (non-empty string)',
        );
      }
      this.reaperPrincipal = rp as PrincipalId;
      const warnMs = options.reaperWarnMs ?? DEFAULT_REAPER_TTLS.staleWarnMs;
      const abandonMs = options.reaperAbandonMs ?? DEFAULT_REAPER_TTLS.staleAbandonMs;
      if (!Number.isInteger(warnMs) || warnMs <= 0) {
        throw new Error(
          `LoopRunner: reaperWarnMs must be a positive integer ms (got ${String(warnMs)})`,
        );
      }
      if (!Number.isInteger(abandonMs) || abandonMs <= 0) {
        throw new Error(
          `LoopRunner: reaperAbandonMs must be a positive integer ms (got ${String(abandonMs)})`,
        );
      }
      if (abandonMs <= warnMs) {
        throw new Error(
          `LoopRunner: reaperAbandonMs (${abandonMs}) must be strictly greater than reaperWarnMs (${warnMs})`,
        );
      }
      this.reaperEnvTtls = {
        staleWarnMs: warnMs,
        staleAbandonMs: abandonMs,
      };
      // Track whether the caller supplied explicit env / CLI overrides so
      // the per-tick log can label `defaults` vs `env` accurately. An
      // unset pair means the runner falls through to the hardcoded floor
      // when no canon policy atom exists; an operator scanning the log
      // for "where did these TTLs come from" should see that distinction.
      this.reaperEnvOverride =
        options.reaperWarnMs !== undefined || options.reaperAbandonMs !== undefined;
    } else {
      this.reaperPrincipal = null;
      this.reaperEnvTtls = DEFAULT_REAPER_TTLS;
      this.reaperEnvOverride = false;
    }
    const principal = this.options.principalId as PrincipalId;
    // `promotionThresholds` is passed through so callers can opt out of
    // the L3 requireValidation default (e.g. when a ValidatorRegistry
    // isn't wired yet). Production paths should provide a validator;
    // this escape hatch exists for tests + zero-config bootstrapping.
    this.l2Engine = new PromotionEngine(host, {
      principalId: principal,
      ...(options.promotionThresholds !== undefined
        ? { thresholds: options.promotionThresholds }
        : {}),
    });
    this.l3Engine = new PromotionEngine(host, {
      principalId: principal,
      humanGateTimeoutMs: this.options.l3HumanGateTimeoutMs,
      ...(options.promotionThresholds !== undefined
        ? { thresholds: options.promotionThresholds }
        : {}),
    });
    this.canonTargets = resolveCanonTargets(options);
    this.onTick = options.onTick ?? null;
  }

  stats(): LoopStats {
    return {
      totalTicks: this.tickCounter,
      totalErrors: this.errorCounter,
      lastTick: this.lastReport,
      running: this.running,
    };
  }

  /**
   * Execute one tick. Caller-driven; tests call this directly.
   */
  async tick(): Promise<LoopTickReport> {
    this.tickCounter += 1;
    const tickNumber = this.tickCounter;
    const startedAt = this.host.clock.now();
    const errors: string[] = [];

    let killSwitchTriggered = false;
    let atomsDecayed = 0;
    let atomsExpired = 0;
    let l2Promoted = 0;
    let l2Rejected = 0;
    let l3Proposed = 0;
    let canonApplied = 0;
    let reaperReport: LoopTickReport['reaperReport'] = null;
    let planReconcileReport: LoopTickReport['planReconcileReport'] = null;
    let planObservationRefreshReport: LoopTickReport['planObservationRefreshReport'] = null;
    let planProposalNotifyReport: LoopTickReport['planProposalNotifyReport'] = null;

    if (this.host.scheduler.killswitchCheck()) {
      killSwitchTriggered = true;
      const finishedAt = this.host.clock.now();
      const report: LoopTickReport = {
        tickNumber,
        startedAt,
        finishedAt,
        killSwitchTriggered,
        atomsDecayed,
        atomsExpired,
        l2Promoted,
        l2Rejected,
        l3Proposed,
        canonApplied,
        errors,
        reaperReport,
        planReconcileReport,
        planObservationRefreshReport,
        planProposalNotifyReport,
      };
      this.lastReport = report;
      return report;
    }

    // --- TTL expiration pass ------------------------------------------------
    // Runs BEFORE decay so a TTL-quarantined atom does not get its confidence
    // recomputed on the same tick (decay skips taint !== 'clean').
    if (this.options.runTtlPass) {
      try {
        atomsExpired = await this.ttlPass();
      } catch (err) {
        this.errorCounter += 1;
        errors.push(
          `ttl-pass: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- Decay pass ---------------------------------------------------------
    try {
      atomsDecayed = await this.decayPass();
    } catch (err) {
      this.errorCounter += 1;
      errors.push(
        `decay-pass: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // --- L2 promotion pass --------------------------------------------------
    if (this.options.runL2Promotion) {
      try {
        const outcomes = await this.l2Engine.runPass('L2');
        for (const o of outcomes) {
          if (o.kind === 'promoted') l2Promoted += 1;
          else if (o.kind === 'rejected-by-policy') l2Rejected += 1;
        }
      } catch (err) {
        this.errorCounter += 1;
        errors.push(
          `l2-promotion: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- L3 promotion pass --------------------------------------------------
    if (this.options.runL3Promotion) {
      try {
        const outcomes = await this.l3Engine.runPass('L3');
        for (const o of outcomes) {
          if (o.kind === 'promoted') l3Proposed += 1;
        }
      } catch (err) {
        this.errorCounter += 1;
        errors.push(
          `l3-promotion: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- Canon applier ------------------------------------------------------
    // Each configured target renders independently. canonApplied counts how
    // many targets actually wrote a changed file this tick (zero for
    // byte-identical state, thanks to the generator's atom-derived "now").
    if (this.options.runCanonApplier && this.canonTargets.length > 0) {
      for (const target of this.canonTargets) {
        try {
          const page = await this.host.atoms.query(
            target.atomFilter,
            target.maxAtoms,
          );
          const result = await target.manager.applyCanon(
            page.atoms,
            target.renderOptions ?? {},
          );
          if (result.changed) canonApplied += 1;
        } catch (err) {
          this.errorCounter += 1;
          errors.push(
            `canon-applier[${target.manager.filePath}]: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // --- Reaper pass --------------------------------------------------------
    // Default-disabled. When enabled, transitions stale `proposed`
    // plans to `abandoned` so the slate stays a triage list and not
    // an everything-ever-drafted backlog. A reaper failure logs to
    // errors but does NOT fail the tick: the reaper is best-effort
    // cleanup and one aborted sweep should not stall the rest of the
    // loop's responsibilities.
    if (this.options.runReaperPass && this.reaperPrincipal !== null) {
      try {
        reaperReport = await this.reaperPass(this.reaperPrincipal);
      } catch (err) {
        this.errorCounter += 1;
        errors.push(
          `reaper-pass: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- Plan-observation refresh pass --------------------------------------
    // Runs BEFORE reconcile so a non-terminal observation rewritten
    // to terminal state by the refresher is reconciled on the SAME
    // tick. Silent-skip when the refresher seam is absent so the
    // reconcile pass can run alone on deployments where terminal
    // observations are produced by an external driver. A pass
    // failure logs to errors and leaves planObservationRefreshReport
    // null; other passes continue.
    if (this.options.runPlanObservationRefreshPass) {
      if (this.prObservationRefresher === null) {
        if (!this.warnedMissingRefresher) {
          this.warnedMissingRefresher = true;
          // eslint-disable-next-line no-console
          console.error(
            '[plan-obs-refresh] WARN: runPlanObservationRefreshPass=true but no '
              + 'prObservationRefresher seam supplied; pass is skipped this tick. '
              + 'Wire one through LoopOptions.prObservationRefresher to activate. '
              + '(This warning is logged once per runner; subsequent silent-skip '
              + 'ticks stay quiet.)',
          );
        }
      } else {
        try {
          planObservationRefreshReport = await this.planObservationRefreshPass(
            this.prObservationRefresher,
          );
        } catch (err) {
          this.errorCounter += 1;
          errors.push(
            `plan-obs-refresh: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // --- Plan-state reconcile pass ------------------------------------------
    // Default-disabled. When enabled, transitions plans whose linked
    // pr-observation atoms carry a terminal pr_state from
    // 'executing'/'approved' to 'succeeded'/'abandoned'. In-process:
    // no external I/O; cost scales with the count of pr-observation
    // atoms, bounded inside the tick by maxScan (default 5000). A
    // reconcile failure logs to errors and leaves planReconcileReport
    // null without failing the tick.
    if (this.options.runPlanReconcilePass) {
      try {
        planReconcileReport = await this.planReconcilePass();
      } catch (err) {
        this.errorCounter += 1;
        errors.push(
          `plan-reconcile: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- Plan-proposal notify pass ------------------------------------------
    // Default-disabled. When enabled, scans proposed plans whose
    // principal is in the canon-defined allowlist and calls the
    // PlanProposalNotifier seam exactly once per plan (idempotence
    // via plan-push-record atoms). Runs AFTER reconcile so a
    // plan that just transitioned proposed -> abandoned this tick
    // is not pushed. Silent-skip when the notifier seam is absent
    // (once-per-runner warning; subsequent ticks stay quiet).
    if (this.options.runPlanProposalNotifyPass) {
      if (this.planProposalNotifier === null) {
        if (!this.warnedMissingNotifier) {
          this.warnedMissingNotifier = true;
          // eslint-disable-next-line no-console
          console.error(
            '[plan-proposal-notify] WARN: runPlanProposalNotifyPass=true but no '
              + 'planProposalNotifier seam supplied; pass is skipped this tick. '
              + 'Wire one through LoopOptions.planProposalNotifier to activate. '
              + '(This warning is logged once per runner; subsequent silent-skip '
              + 'ticks stay quiet.)',
          );
        }
      } else {
        try {
          planProposalNotifyReport = await this.planProposalNotifyPass(
            this.planProposalNotifier,
          );
        } catch (err) {
          this.errorCounter += 1;
          errors.push(
            `plan-proposal-notify: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const finishedAt = this.host.clock.now();
    const report: LoopTickReport = {
      tickNumber,
      startedAt,
      finishedAt,
      killSwitchTriggered,
      atomsDecayed,
      atomsExpired,
      l2Promoted,
      l2Rejected,
      l3Proposed,
      canonApplied,
      errors,
      reaperReport,
      planReconcileReport,
      planObservationRefreshReport,
      planProposalNotifyReport,
    };
    this.lastReport = report;

    this.host.auditor.metric('loop.ticks', 1);
    this.host.auditor.metric('loop.atoms_decayed', atomsDecayed);
    this.host.auditor.metric('loop.atoms_expired', atomsExpired);
    this.host.auditor.metric('loop.l2_promoted', l2Promoted);
    this.host.auditor.metric('loop.l3_proposed', l3Proposed);
    if (reaperReport !== null) {
      this.host.auditor.metric('loop.reaper_swept', reaperReport.swept);
      this.host.auditor.metric('loop.reaper_abandoned', reaperReport.abandoned);
    }
    if (planReconcileReport !== null) {
      this.host.auditor.metric('loop.plan_reconcile_scanned', planReconcileReport.scanned);
      this.host.auditor.metric(
        'loop.plan_reconcile_transitioned',
        planReconcileReport.transitioned,
      );
    }
    if (planObservationRefreshReport !== null) {
      this.host.auditor.metric(
        'loop.plan_obs_refresh_scanned',
        planObservationRefreshReport.scanned,
      );
      this.host.auditor.metric(
        'loop.plan_obs_refresh_refreshed',
        planObservationRefreshReport.refreshed,
      );
    }
    if (planProposalNotifyReport !== null) {
      this.host.auditor.metric(
        'loop.plan_proposal_notify_scanned',
        planProposalNotifyReport.scanned,
      );
      this.host.auditor.metric(
        'loop.plan_proposal_notify_notified',
        planProposalNotifyReport.notified,
      );
    }

    await this.host.auditor.log({
      kind: 'loop.tick',
      principal_id: this.options.principalId as PrincipalId,
      timestamp: finishedAt as Time,
      refs: {},
      details: {
        tick_number: tickNumber,
        atoms_decayed: atomsDecayed,
        atoms_expired: atomsExpired,
        l2_promoted: l2Promoted,
        l3_proposed: l3Proposed,
        canon_applied: canonApplied,
        ...(reaperReport !== null
          ? {
              reaper_swept: reaperReport.swept,
              reaper_abandoned: reaperReport.abandoned,
              reaper_warned: reaperReport.warned,
              reaper_fresh: reaperReport.fresh,
            }
          : {}),
        ...(planReconcileReport !== null
          ? {
              plan_reconcile_scanned: planReconcileReport.scanned,
              plan_reconcile_matched: planReconcileReport.matched,
              plan_reconcile_transitioned: planReconcileReport.transitioned,
              plan_reconcile_claim_conflicts: planReconcileReport.claimConflicts,
            }
          : {}),
        ...(planObservationRefreshReport !== null
          ? {
              plan_obs_refresh_scanned: planObservationRefreshReport.scanned,
              plan_obs_refresh_refreshed: planObservationRefreshReport.refreshed,
            }
          : {}),
        ...(planProposalNotifyReport !== null
          ? {
              plan_proposal_notify_scanned: planProposalNotifyReport.scanned,
              plan_proposal_notify_notified: planProposalNotifyReport.notified,
            }
          : {}),
      },
    });

    if (this.onTick) {
      try {
        await this.onTick(report);
      } catch {
        /* onTick errors are advisory; do not fail the tick */
      }
    }

    return report;
  }

  /**
   * Start a self-driving loop at the given interval. Each tick runs on
   * schedule until `stop()` is called, the STOP file appears, or the host
   * is torn down.
   */
  async start(intervalMs: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    const runAndReschedule = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch {
        /* individual tick errors already logged; do not halt loop */
      }
      if (!this.running) return;
      const timer = setTimeout(() => {
        void runAndReschedule();
      }, intervalMs);
      this.cancelNextTimer = () => clearTimeout(timer);
    };
    await runAndReschedule();
  }

  stop(): void {
    this.running = false;
    if (this.cancelNextTimer) {
      this.cancelNextTimer();
      this.cancelNextTimer = null;
    }
  }

  // ---- Private ----

  /**
   * Scan all layers for atoms with a past expires_at and mark them
   * quarantined. Idempotent: re-running leaves already-quarantined atoms
   * untouched.
   */
  private async ttlPass(): Promise<number> {
    const nowMs = Date.parse(this.host.clock.now());
    let scanned = 0;
    let expired = 0;
    for (const layer of ['L0', 'L1', 'L2', 'L3'] as const) {
      if (scanned >= this.options.maxAtomsPerTick) break;
      const page = await this.host.atoms.query(
        { layer: [layer] },
        this.options.maxAtomsPerTick - scanned,
      );
      for (const atom of page.atoms) {
        scanned += 1;
        const patch = ttlExpirePatch(atom, nowMs, {
          floor: this.options.minConfidence,
        });
        if (patch) {
          try {
            await this.host.atoms.update(atom.id, patch);
            expired += 1;
            await this.host.auditor.log({
              kind: 'atom.expired',
              principal_id: this.options.principalId as PrincipalId,
              timestamp: this.host.clock.now() as Time,
              refs: { atom_ids: [atom.id] },
              details: {
                expires_at: atom.expires_at,
                layer: atom.layer,
                type: atom.type,
              },
            });
          } catch {
            /* individual failure tolerated */
          }
        }
      }
    }
    return expired;
  }

  private async decayPass(): Promise<number> {
    // Decay applies to non-superseded atoms at L0/L1/L2 (canon is human-
    // signed and exempt). Limit per tick via maxAtomsPerTick to bound cost.
    const nowMs = Date.parse(this.host.clock.now());
    let scanned = 0;
    let updated = 0;
    for (const layer of ['L0', 'L1', 'L2'] as const) {
      if (scanned >= this.options.maxAtomsPerTick) break;
      const page = await this.host.atoms.query(
        { layer: [layer] },
        this.options.maxAtomsPerTick - scanned,
      );
      for (const atom of page.atoms) {
        scanned += 1;
        const next = decayedConfidence(
          atom,
          nowMs,
          this.options.halfLives,
          this.options.minConfidence,
        );
        if (shouldUpdateConfidence(atom.confidence, next)) {
          try {
            await this.host.atoms.update(atom.id, { confidence: next });
            updated += 1;
          } catch {
            /* individual update failure tolerated */
          }
        }
      }
    }
    return updated;
  }

  /**
   * Run a single reaper sweep and shape the result into the per-tick
   * report struct. Validates the configured principal exists in the
   * host's PrincipalStore on first call so a misconfigured wiring
   * fails loud (rather than producing audit rows attributed to a
   * non-existent identity).
   *
   * TTL resolution order on every pass (re-read each tick so a canon
   * edit takes effect on the next sweep without a daemon restart):
   *   1. canon reaper-ttls policy atom (preferred)
   *   2. `LoopOptions.reaperWarnMs` / `reaperAbandonMs` (CLI / env)
   *   3. `DEFAULT_REAPER_TTLS` (hardcoded floor)
   *
   * Each pass logs one stderr line naming the source so an operator
   * scanning logs can see which path the TTLs came from at a glance.
   */
  private async reaperPass(
    principal: PrincipalId,
  ): Promise<NonNullable<LoopTickReport['reaperReport']>> {
    if (!this.reaperPrincipalChecked) {
      const found = await this.host.principals.get(principal);
      if (found === null) {
        // Do NOT flip reaperPrincipalChecked here. A later
        // (re-)provision of the principal must be picked up on the
        // next tick rather than permanently skipped by a one-shot
        // boot-time miss. The thrown error is caught by the tick
        // loop and surfaced via errors[]; this preserves the loud-
        // fail signal without poisoning the cache.
        throw new Error(
          `LoopRunner: reaperPrincipal '${String(principal)}' not found in host.principals`,
        );
      }
      this.reaperPrincipalChecked = true;
    }
    // Re-read canon every tick so a reaper-ttls policy edit takes
    // effect on the NEXT pass without a daemon restart. The reader
    // returns null on absence OR malformed payload; in the malformed
    // case it has already logged a stderr warning, so the fall-
    // through here is the recovery path the operator was warned
    // about.
    const fromCanon = await readReaperTtlsFromCanon(this.host);
    let ttls: ReaperTtls;
    let source: 'canon-policy' | 'env' | 'defaults';
    if (fromCanon !== null) {
      ttls = fromCanon;
      source = 'canon-policy';
    } else if (this.reaperEnvOverride) {
      ttls = this.reaperEnvTtls;
      source = 'env';
    } else {
      ttls = this.reaperEnvTtls; // == DEFAULT_REAPER_TTLS when no override
      source = 'defaults';
    }
    // Loud-at-boundaries: one line per pass naming the source. Goes
    // to stderr so it does not pollute the structured tick stdout
    // stream. An operator wanting to see which TTL path the loop
    // chose at any moment greps for "[reaper] using TTLs".
    // eslint-disable-next-line no-console
    console.error(
      `[reaper] using TTLs from ${source}: warn=${ttls.staleWarnMs}ms abandon=${ttls.staleAbandonMs}ms`,
    );
    const sweep: RunReaperSweepResult = await runReaperSweep(
      this.host,
      principal,
      ttls,
    );
    const fresh = sweep.classifications.fresh.length;
    const warned = sweep.classifications.warn.length;
    const abandonClassified = sweep.classifications.abandon.length;
    const abandoned = sweep.apply.abandoned.length;
    return {
      swept: fresh + warned + abandonClassified,
      abandoned,
      warned,
      fresh,
    };
  }

  /**
   * Run one plan-state reconcile pass. Pure delegate to
   * `runPlanStateReconcileTick`; LoopRunner adds scheduling + audit
   * only. The tick function in a separate module remains the single
   * source of truth for the reconcile algorithm.
   */
  private async planReconcilePass(): Promise<
    NonNullable<LoopTickReport['planReconcileReport']>
  > {
    const result: PlanReconcileTickResult = await runPlanStateReconcileTick(this.host);
    return {
      scanned: result.scanned,
      matched: result.matched,
      transitioned: result.transitioned,
      claimConflicts: result.claimConflicts,
    };
  }

  /**
   * Run one pr-observation refresh pass. Pure delegate to
   * `runPlanObservationRefreshTick`; LoopRunner adds scheduling +
   * audit only. The pluggable `PrObservationRefresher` seam is
   * supplied at construction time via
   * `LoopOptions.prObservationRefresher`. The freshness threshold
   * is read inside the tick from canon
   * `pol-pr-observation-freshness-threshold-ms` (default 5 minutes).
   */
  private async planObservationRefreshPass(
    refresher: PrObservationRefresher,
  ): Promise<NonNullable<LoopTickReport['planObservationRefreshReport']>> {
    const result: PlanObservationRefreshResult = await runPlanObservationRefreshTick(
      this.host,
      refresher,
    );
    return {
      scanned: result.scanned,
      refreshed: result.refreshed,
      skipped: result.skipped,
    };
  }

  /**
   * Run one plan-proposal notify pass. Pure delegate to
   * `runPlanProposalNotifyTick`; LoopRunner adds scheduling + audit
   * only. The pluggable `PlanProposalNotifier` seam is supplied at
   * construction time via `LoopOptions.planProposalNotifier`. The
   * principal allowlist is read inside the tick from the canon
   * `telegram-plan-trigger-principals` policy subject; concrete
   * principal names are carried by canon, bootstrap, and docs
   * rather than embedded here.
   */
  private async planProposalNotifyPass(
    notifier: PlanProposalNotifier,
  ): Promise<NonNullable<LoopTickReport['planProposalNotifyReport']>> {
    const result: PlanProposalNotifyResult = await runPlanProposalNotifyTick(
      this.host,
      notifier,
      this.planProposalNotifyPrincipal,
    );
    return {
      scanned: result.scanned,
      notified: result.notified,
      skipped: result.skipped,
    };
  }
}

// Keep AtomType export path conformant with types.ts for tests.
export type { AtomType };

/**
 * Normalize the canon-target options into an array of resolved targets.
 *
 * Precedence:
 *   1. If `canonTargets` is set (and non-empty), use it as-is.
 *   2. Else if `canonTargetPath` is set, synthesize one target from the
 *      legacy single-target options.
 *   3. Else no targets.
 *
 * The mandatory `{ layer: ['L3'] }` filter is merged into every target
 * here so callers never have to restate it.
 */
function resolveCanonTargets(options: LoopOptions): ResolvedCanonTarget[] {
  const defaultMax = options.canonMaxAtoms ?? 500;
  const explicit = options.canonTargets ?? [];
  const raw: ReadonlyArray<CanonTarget> = explicit.length > 0
    ? explicit
    : options.canonTargetPath
      ? [{ path: options.canonTargetPath, maxAtoms: defaultMax }]
      : [];
  return raw.map(t => {
    const filter: AtomFilter = {
      ...(t.filter ?? {}),
      layer: ['L3'], // always force L3; per-target filter can narrow further
    };
    const resolved: ResolvedCanonTarget = {
      manager: new CanonMdManager({ filePath: t.path }),
      atomFilter: filter,
      maxAtoms: t.maxAtoms ?? defaultMax,
      renderOptions: t.renderOptions,
    };
    return resolved;
  });
}
