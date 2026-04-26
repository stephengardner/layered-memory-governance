/**
 * Plan staleness reaper.
 *
 * Any actor that proposes work writes a plan atom. Without an automated
 * terminal-state path those proposed atoms accumulate forever - the
 * Plans projection ends up showing "everything that was ever drafted"
 * instead of "the in-flight slate to triage." The reaper closes that
 * gap by transitioning proposed plans older than a TTL to `abandoned`,
 * with an audit trail. Content is preserved (atoms are never deleted);
 * the label is the change.
 *
 * Composition with the existing plan state machine: the reaper calls
 * the existing `transitionPlanState` primitive for every transition,
 * which validates against the state machine and emits an audit event.
 * The reaper is a driver over the transition primitive, not a parallel
 * mutation surface.
 *
 * Default TTLs are conservative (24h warn / 72h auto-abandon). They
 * are passed as parameters, not module constants, so deployment policy
 * can override per-instance without a code change. Keeping thresholds
 * out of the framework is substrate-not-prescription: the framework
 * defines the mechanism, deployment configuration defines the values.
 *
 * What the reaper does NOT do (deferred to follow-ups):
 *   - Auto-approve. The reaper only labels; approval remains a
 *     deliberate human-in-the-loop step.
 *   - Resurrect superseded plans. If a stale plan was superseded by a
 *     newer plan that already shipped (the work landed via a different
 *     PR), the reaper still abandons it. Operators get the "this work
 *     was completed elsewhere" signal from the supersession chain, not
 *     from a state flip. A follow-up may add a `succeeded_via_pr`
 *     resolution path.
 *   - Per-plan inbox spam. The driver script collapses the sweep into
 *     a single stdout summary in V0; a digest-style actor-message is
 *     the next refinement.
 */

import type { Host } from '../../substrate/interface.js';
import type { Atom, AtomId, PrincipalId } from '../../substrate/types.js';
import type { AtomFilter } from '../../substrate/types.js';
import { canTransition, transitionPlanState } from './state.js';

/**
 * TTL configuration for the reaper, in milliseconds. Both values are
 * positive and `staleAbandonMs >= staleWarnMs` so a plan first crosses
 * the warn line, then the abandon line.
 *
 * Values come from canon `pol-plan-staleness` when the driver script
 * is wired through a Host; the type ships with safe fallbacks for unit
 * tests and standalone scripts that don't load canon.
 */
export interface ReaperTtls {
  readonly staleWarnMs: number;
  readonly staleAbandonMs: number;
}

export const DEFAULT_REAPER_TTLS: ReaperTtls = Object.freeze({
  // 24h: a plan that hasn't been approved or progressed in a day is
  // unlikely to ship without active operator engagement; surface it as
  // stale-warning so the operator can decide.
  staleWarnMs: 24 * 60 * 60 * 1000,
  // 72h: a plan that's been proposed for three days without movement
  // is reliably abandoned in practice. The TTL is conservative; canon
  // raises or lowers it via pol-plan-staleness.
  staleAbandonMs: 72 * 60 * 60 * 1000,
});

/**
 * Result of classifying a plan against the TTLs. Exposed for unit
 * tests and the driver script's reporting.
 */
export type ReaperBucket = 'fresh' | 'warn' | 'abandon';

export interface ReaperClassification {
  readonly atomId: AtomId;
  readonly bucket: ReaperBucket;
  readonly ageMs: number;
}

/**
 * Pure: classify a single plan atom against the reaper TTLs. Returns
 * `null` when the atom is not a plan in `proposed` state - only
 * proposed plans are reaper-eligible. Approved/executing plans are
 * the operator's responsibility (they were authorized); terminal
 * states are immutable per the state machine.
 *
 * `nowMs` is epoch milliseconds (whatever the caller resolves from
 * `host.clock.now()` via `Date.parse`); the helper stays unit-pure so
 * tests can pin time without a clock fake.
 */
export function classifyPlan(
  atom: Atom,
  nowMs: number,
  ttls: ReaperTtls = DEFAULT_REAPER_TTLS,
): ReaperClassification | null {
  if (atom.type !== 'plan') return null;
  if (atom.plan_state !== 'proposed') return null;
  const created = Date.parse(atom.created_at);
  if (!Number.isFinite(created)) return null;
  const ageMs = nowMs - created;
  if (ageMs < 0) return null; // future-dated atoms (clock skew) are not stale
  let bucket: ReaperBucket = 'fresh';
  if (ageMs >= ttls.staleAbandonMs) bucket = 'abandon';
  else if (ageMs >= ttls.staleWarnMs) bucket = 'warn';
  return { atomId: atom.id, bucket, ageMs };
}

/**
 * Pure: classify a list of plans into the three buckets. Used by the
 * driver script to produce the digest summary (fresh count, warn
 * count, abandon list).
 */
export interface ReaperClassifications {
  readonly fresh: ReadonlyArray<ReaperClassification>;
  readonly warn: ReadonlyArray<ReaperClassification>;
  readonly abandon: ReadonlyArray<ReaperClassification>;
}

export function classifyPlans(
  atoms: ReadonlyArray<Atom>,
  nowMs: number,
  ttls: ReaperTtls = DEFAULT_REAPER_TTLS,
): ReaperClassifications {
  const fresh: ReaperClassification[] = [];
  const warn: ReaperClassification[] = [];
  const abandon: ReaperClassification[] = [];
  for (const atom of atoms) {
    const c = classifyPlan(atom, nowMs, ttls);
    if (!c) continue;
    if (c.bucket === 'abandon') abandon.push(c);
    else if (c.bucket === 'warn') warn.push(c);
    else fresh.push(c);
  }
  return { fresh, warn, abandon };
}

/**
 * Apply the reap: transition every plan in the `abandon` bucket to
 * `abandoned`. Each transition flows through `transitionPlanState`
 * so it gets validated against the state machine and audited via
 * `host.auditor.log`. Returns the list of plans actually abandoned
 * (some may fail validation if their state changed under us between
 * classify and apply - we log and skip those, never throw).
 *
 * The reason string carries the age in hours so an operator scanning
 * audit history sees `stale-no-approval-after-72h` instead of an
 * opaque `stale`. That's a small bytes cost for a large legibility
 * win - the audit log IS the operator's view into autonomous
 * mutations, and a vague reason there is the same as no reason.
 */
export interface ReapApplyResult {
  readonly abandoned: ReadonlyArray<{
    readonly atomId: AtomId;
    readonly ageHours: number;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly atomId: AtomId;
    readonly error: string;
  }>;
}

export async function applyReap(
  host: Host,
  principalId: PrincipalId,
  classifications: ReaperClassifications,
): Promise<ReapApplyResult> {
  const abandoned: { atomId: AtomId; ageHours: number }[] = [];
  const skipped: { atomId: AtomId; error: string }[] = [];
  for (const c of classifications.abandon) {
    const ageHours = Math.round(c.ageMs / 3600000);
    try {
      // Re-fetch right before transition so we honor any state change
      // that happened between classify and apply. canTransition guards
      // the transition; we use it for a non-throwing pre-check so the
      // error path is one place.
      const fresh = await host.atoms.get(c.atomId);
      if (!fresh) {
        skipped.push({ atomId: c.atomId, error: 'atom-disappeared' });
        continue;
      }
      // Specifically require still-proposed: an approved/executing plan
      // is no longer "stale-without-approval" so the reaper has no
      // standing to abandon it. The substrate state-machine WOULD
      // accept approved->abandoned, but that decision belongs to the
      // operator, not the reaper - we explicitly narrow the criterion.
      if (
        fresh.type !== 'plan' ||
        fresh.plan_state !== 'proposed' ||
        !canTransition(fresh.plan_state, 'abandoned')
      ) {
        skipped.push({
          atomId: c.atomId,
          error: `state-changed:${fresh.plan_state ?? 'no-plan-state'}`,
        });
        continue;
      }
      await transitionPlanState(
        c.atomId,
        'abandoned',
        host,
        principalId,
        `stale-no-approval-after-${ageHours}h`,
      );
      abandoned.push({ atomId: c.atomId, ageHours });
    } catch (err) {
      skipped.push({
        atomId: c.atomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { abandoned, skipped };
}

/**
 * Page through every proposed plan in the store. We use the existing
 * paginated `query` interface and re-call until the cursor exhausts;
 * each page is `PAGE_SIZE` atoms. The reaper is a sweep so we want
 * full coverage, not an arbitrary truncation; pagination is the
 * substrate-correct way to bound memory while still seeing
 * everything.
 */
const PAGE_SIZE = 500;

async function loadAllProposedPlans(host: Host): Promise<ReadonlyArray<Atom>> {
  const filter: AtomFilter = { type: ['plan'], plan_state: ['proposed'] };
  const collected: Atom[] = [];
  let cursor: string | undefined;
  // Bound the loop so a misbehaving adapter never spins forever.
  // 200 pages * 500 = 100k atoms, well above any realistic single-run
  // backlog (we re-run periodically anyway).
  for (let i = 0; i < 200; i++) {
    const page = await host.atoms.query(filter, PAGE_SIZE, cursor);
    for (const a of page.atoms) collected.push(a);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return collected;
}

/**
 * One-shot driver: classify + apply. Convenience for callers that
 * want the whole sweep in one call (the script driver, future
 * scheduler hooks). Returns both the classifications (for the digest
 * summary) and the apply result (what actually happened).
 */
export async function runReaperSweep(
  host: Host,
  principalId: PrincipalId,
  ttls: ReaperTtls = DEFAULT_REAPER_TTLS,
): Promise<{
  readonly classifications: ReaperClassifications;
  readonly apply: ReapApplyResult;
}> {
  // host.clock.now() returns Time (ISO8601 string). Date.parse gives
  // epoch milliseconds for arithmetic.
  const nowMs = Date.parse(host.clock.now());
  const all = await loadAllProposedPlans(host);
  const classifications = classifyPlans(all, nowMs, ttls);
  const apply = await applyReap(host, principalId, classifications);
  return { classifications, apply };
}
