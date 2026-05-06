/**
 * Plan-proposal notify tick.
 *
 * Closes the substrate gap where new proposed plan atoms accumulate
 * during autonomous loop sessions but the operator gets no
 * notification unless they manually run a per-plan dispatch script.
 * This tick scans proposed plan atoms whose principal is in the
 * canon-defined allowlist, calls a pluggable PlanProposalNotifier
 * seam exactly once per plan, and writes an idempotence-record atom
 * to make the push idempotent across re-ticks.
 *
 * Substrate purity: this module never imports a notifier client,
 * never reads env vars, never spawns a process, never formats a
 * channel-specific message. The PlanProposalNotifier seam takes the
 * raw plan atom; the deployment-side adapter does any
 * channel-specific formatting + transport.
 *
 * Per-tick fairness: maxNotifies bounds the per-tick adapter-call
 * budget; plans beyond the cap are counted as 'rate-limited' and
 * picked up next tick. maxScan bounds total atoms inspected per
 * tick to keep the scan cost O(maxScan) regardless of store size.
 *
 * Idempotence design: a 'plan-push-record' atom is written per
 * notified plan with provenance.derived_from: [planId]. The next
 * tick queries the existing records and short-circuits any plan
 * whose id already appears in the set. A failed notify (adapter
 * throw) deliberately does NOT write the record so the next tick
 * retries; the operator always eventually sees the plan when the
 * channel recovers. The atom type is transport-neutral; the
 * channel name (telegram, slack, email, ...) lives in
 * metadata.channel so a future deployment swapping notifiers does
 * not need a substrate migration.
 *
 * Allowlist source: a directive policy atom carrying
 * metadata.policy.subject = 'telegram-plan-trigger-principals'.
 * The framework default lives in DEFAULT_PRINCIPAL_ALLOWLIST and is
 * applied when no policy atom resolves; concrete principal names
 * are an org-shape concern carried by canon and bootstrap docs,
 * not by this module. An explicitly empty principal_ids array is
 * the canon opt-out path.
 */

import type { Host } from '../../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../types.js';
import {
  DEFAULT_PRINCIPAL_ALLOWLIST,
  readPlanTriggerAllowlist,
} from '../loop/telegram-plan-trigger-allowlist.js';

/**
 * Pluggable seam for the deployment-side adapter that delivers the
 * plan to whatever channel the deployment chose (Telegram in the
 * indie-floor reference impl; Slack / email / multi-chat in
 * org-ceiling deployments). The adapter receives the raw plan atom
 * so it can do channel-specific formatting (the framework stays
 * out of formatting decisions).
 *
 * Errors thrown by `notify` are caught by the tick and counted as
 * `skipped['notify-failed']`; the idempotence record is NOT written
 * for failed sends so the next tick retries.
 */
export interface PlanProposalNotifier {
  notify(args: { readonly plan: Atom }): Promise<void>;
}

export interface PlanProposalNotifyOptions {
  /** Time provider; defaults to host clock. Test injection point. */
  readonly now?: () => string;
  /** Upper bound on plan atoms scanned per tick; defaults to 5000. */
  readonly maxScan?: number;
  /**
   * Upper bound on notifier.notify calls per tick. Defaults to 5,
   * which is conservative against per-chat rate limits on common
   * messaging APIs (Telegram caps at ~30 msg/sec/chat overall but
   * practical posting against a single chat keeps a much tighter
   * budget on bursts to avoid 429s). Adapters that fan out across
   * multiple chats or implement their own backoff can raise this
   * via options at construction time. Plans beyond the cap are
   * counted as 'rate-limited' and picked up next tick, so the
   * overall throughput is bounded by tick-cadence x maxNotifies
   * regardless.
   */
  readonly maxNotifies?: number;
  /**
   * Override the canon allowlist read. Test injection point.
   * Production callers leave this undefined and let the canon read
   * supply the list.
   */
  readonly principalAllowlistOverride?: ReadonlyArray<PrincipalId>;
}

export interface PlanProposalNotifyResult {
  readonly scanned: number;
  readonly notified: number;
  readonly skipped: Record<string, number>;
}

/**
 * The notify tick. Mechanism-only: no channel I/O, no env reads, no
 * string parsing. Reads plan atoms, filters to those needing a push,
 * delegates the actual send to the injected adapter, writes the
 * idempotence record on success.
 */
export async function runPlanProposalNotifyTick(
  host: Host,
  notifier: PlanProposalNotifier,
  notifyPrincipal: PrincipalId,
  options: PlanProposalNotifyOptions = {},
): Promise<PlanProposalNotifyResult> {
  const nowFn = options.now ?? (() => host.clock.now() as string);
  const MAX_SCAN = options.maxScan ?? 5_000;
  const MAX_NOTIFIES = options.maxNotifies ?? 5;
  const allowlist
    = options.principalAllowlistOverride ?? (await readPlanTriggerAllowlist(host));
  const allowSet = new Set<string>(allowlist);

  // Empty allowlist short-circuits without scanning the plan set.
  // This is the explicit canon opt-out path; doing the scan first
  // would burn cycles for nothing.
  if (allowSet.size === 0) {
    return { scanned: 0, notified: 0, skipped: {} };
  }

  const PAGE_SIZE = 500;
  let scanned = 0;
  let notified = 0;
  const skipped: Record<string, number> = {};
  const bump = (k: string): void => {
    skipped[k] = (skipped[k] ?? 0) + 1;
  };

  // Pre-scan existing push-records to build a Set of already-pushed
  // plan IDs. One scan up-front is cheaper than N point-queries
  // inside the plan loop, and the record set is bounded by the
  // 1-week half-life decay, so it stays warm in steady state.
  const pushedPlanIds = new Set<string>();
  {
    let cursor: string | undefined;
    do {
      const page = await host.atoms.query(
        { type: ['plan-push-record'] },
        PAGE_SIZE,
        cursor,
      );
      for (const rec of page.atoms) {
        if (rec.taint !== 'clean') continue;
        if (rec.superseded_by.length > 0) continue;
        const meta = rec.metadata as Record<string, unknown>;
        const planId = meta['plan_id'];
        if (typeof planId === 'string' && planId.length > 0) {
          pushedPlanIds.add(planId);
        }
      }
      cursor = page.nextCursor === null ? undefined : page.nextCursor;
    } while (cursor !== undefined);
  }

  let cursor: string | undefined;
  do {
    const remaining = MAX_SCAN - scanned;
    if (remaining <= 0) break;
    const page = await host.atoms.query(
      { type: ['plan'], plan_state: ['proposed'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    for (const plan of page.atoms) {
      scanned += 1;
      if (plan.taint !== 'clean') {
        bump('tainted');
        continue;
      }
      if (plan.superseded_by.length > 0) {
        bump('superseded');
        continue;
      }
      if (!allowSet.has(String(plan.principal_id))) {
        bump('not-in-allowlist');
        continue;
      }
      if (pushedPlanIds.has(String(plan.id))) {
        bump('already-pushed');
        continue;
      }
      if (notified >= MAX_NOTIFIES) {
        bump('rate-limited');
        continue;
      }
      try {
        await notifier.notify({ plan });
      } catch {
        bump('notify-failed');
        continue;
      }
      // Write the idempotence record AFTER a successful notify. A
      // crash between the two leaves the plan re-pushable next
      // tick; this is the correct failure mode (better duplicate
      // ping than silent drop). The id embeds the plan id + the
      // current timestamp so re-runs at distinct moments do not
      // collide; only one "wins" per plan because the next tick
      // sees pushedPlanIds populated.
      const nowIso = nowFn();
      const recordId = `plan-push-${String(plan.id)}-${nowIso}` as AtomId;
      const record: Atom = {
        schema_version: 1,
        id: recordId,
        content: `plan ${String(plan.id)} pushed via the plan-proposal notify pass`,
        type: 'plan-push-record',
        layer: 'L0',
        provenance: {
          kind: 'agent-observed',
          source: {
            agent_id: notifyPrincipal as string,
            tool: 'plan-proposal-notify-tick',
          },
          derived_from: [plan.id],
        },
        confidence: 1.0,
        created_at: nowIso as Time,
        last_reinforced_at: nowIso as Time,
        expires_at: null,
        supersedes: [],
        superseded_by: [],
        scope: 'session',
        signals: {
          agrees_with: [],
          conflicts_with: [],
          validation_status: 'unchecked',
          last_validated_at: null,
        },
        principal_id: notifyPrincipal,
        taint: 'clean',
        metadata: {
          plan_id: String(plan.id),
          pushed_at: nowIso,
          channel: 'telegram',
        },
      };
      try {
        await host.atoms.put(record);
        notified += 1;
        pushedPlanIds.add(String(plan.id));
      } catch {
        // Write failure: don't increment notified (the operator
        // got the message, but we couldn't persist the
        // idempotence). The next tick will re-notify on this
        // plan, which is a duplicate -- but a duplicate ping is
        // preferable to a silently-lost audit record. Counted
        // distinctly so the operator sees the anomaly in the
        // per-tick report.
        bump('record-write-failed');
      }
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);

  return { scanned, notified, skipped };
}

// Re-export so test suites and the LoopRunner can pin the default
// allowlist without reaching into the loop module.
export { DEFAULT_PRINCIPAL_ALLOWLIST };
