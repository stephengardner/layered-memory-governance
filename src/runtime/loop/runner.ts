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
    >
  >;
  private readonly l2Engine: PromotionEngine;
  private readonly l3Engine: PromotionEngine;
  private readonly canonTargets: ReadonlyArray<ResolvedCanonTarget>;
  private readonly onTick: ((report: LoopTickReport) => void | Promise<void>) | null;
  private readonly reaperPrincipal: PrincipalId | null;
  private readonly reaperTtls: ReaperTtls;
  /**
   * `null` means we have not yet checked the principal exists in the
   * host's PrincipalStore. We defer the lookup to the first reaper
   * pass (vs. failing in the constructor) because the constructor
   * is sync; once the lookup runs we cache the result so subsequent
   * ticks do not re-hit the store.
   */
  private reaperPrincipalChecked: boolean = false;
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
    };
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
      this.reaperTtls = {
        staleWarnMs: warnMs,
        staleAbandonMs: abandonMs,
      };
    } else {
      this.reaperPrincipal = null;
      this.reaperTtls = DEFAULT_REAPER_TTLS;
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
    const sweep: RunReaperSweepResult = await runReaperSweep(
      this.host,
      principal,
      this.reaperTtls,
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
