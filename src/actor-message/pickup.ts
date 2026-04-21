/**
 * Pickup handler: picks the next actor-message atom for a principal,
 * applying the kill-switch sentinel and the ordering policy.
 *
 * Shape is deliberately a single pure-ish function plus a small set
 * of options so schedulers of any stripe (the existing LoopRunner
 * tick, a standalone daemon, a test harness) can invoke it uniformly.
 *
 * Ordering (default): halt > deadline-imminent > urgency > arrival.
 * Deployments override by writing a custom ordering policy atom and
 * passing an `orderingFn` option that reads from it.
 *
 * Kill-switch: a sentinel file path (default `.lag/STOP` relative to
 * the host's state directory; the caller passes the resolved path).
 * If the file exists, pickup returns null with reason 'kill-switch'
 * and does NOT touch the atom store.
 */

import { existsSync } from 'node:fs';
import type { Host } from '../substrate/interface.js';
import type { PrincipalId, Time } from '../substrate/types.js';
import type { InboxMessage } from './inbox-reader.js';
import { emitAck, listUnread } from './inbox-reader.js';
import {
  DEFAULT_ORDERING_POLICY,
  readOrderingPolicy,
  type OrderingPolicyConfig,
} from './ordering-policy.js';

export type PickupOutcome =
  | { readonly kind: 'kill-switch' }
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'picked';
      readonly message: InboxMessage;
      /** Id of the ack atom emitted for this pickup. */
      readonly ackAtomId: string;
    };

/**
 * Ordering function. Lower sort key = higher priority (picked first).
 * Callers can replace via `orderingFn` option; the default orders by:
 *   1. halt flag (none currently; reserved for future signals)
 *   2. deadline-imminent within `deadlineImminentThresholdMs`
 *   3. urgency_tier: high > normal > soft
 *   4. arrival time (ISO created_at ascending, oldest first)
 */
export type OrderingFn = (a: InboxMessage, b: InboxMessage, nowMs: number) => number;

export interface PickupOptions {
  /** Injectable clock. ms since epoch. Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Absolute path to the kill-switch sentinel file. When present the
   * pickup returns 'kill-switch' without touching the store. Callers
   * typically pass `resolve(stateDir, 'STOP')`.
   */
  readonly stopSentinelPath?: string;
  /**
   * Overrideable ordering. When set, fully replaces the default
   * policy-driven ordering. When unset, the default ordering reads
   * pol-inbox-ordering from canon and applies threshold + urgency
   * weights from there.
   */
  readonly orderingFn?: OrderingFn;
  /**
   * Hard override for the imminent-deadline threshold. Use sparingly;
   * prefer editing pol-inbox-ordering via canon so tuning is a canon
   * edit, not a caller decision.
   */
  readonly deadlineImminentThresholdMs?: number;
}

/**
 * Pick (and ack) the next message for the given principal.
 *
 * Returns:
 *   - 'kill-switch' if the sentinel file exists
 *   - 'empty' if the inbox has no unacked messages
 *   - 'picked' with the message + the id of the ack atom that was
 *     emitted for it, otherwise
 *
 * The pickup is "at-most-once": the ack is emitted before the caller
 * receives the message. A caller that crashes between receiving and
 * processing loses the work (the message is now acked). For at-least-
 * once semantics, the caller emits its own follow-up atom that
 * transactionally signals processing completion; this handler does
 * not pretend to provide that by itself. The ack is purely a read-
 * marker.
 */
export async function pickNextMessage(
  host: Host,
  principalId: PrincipalId,
  options: PickupOptions = {},
): Promise<PickupOutcome> {
  const now = options.now ?? (() => Date.now());
  if (options.stopSentinelPath !== undefined && existsSync(options.stopSentinelPath)) {
    return { kind: 'kill-switch' };
  }
  const unread = await listUnread(host, principalId);
  if (unread.length === 0) return { kind: 'empty' };

  let orderingFn = options.orderingFn;
  if (orderingFn === undefined) {
    const policy = await readOrderingPolicy(host);
    const threshold = options.deadlineImminentThresholdMs
      ?? policy.deadline_imminent_threshold_ms;
    orderingFn = defaultOrdering(threshold, policy);
  }
  const nowMs = now();
  const sorted = [...unread].sort((a, b) => orderingFn!(a, b, nowMs));
  const chosen = sorted[0]!;

  const ackAtomId = await emitAck(host, chosen, principalId, { now });
  return { kind: 'picked', message: chosen, ackAtomId: String(ackAtomId) };
}

/**
 * Default ordering: deadline-imminent first, then urgency tier, then
 * arrival time. Lower return = higher priority.
 *
 * When called with only the threshold, urgency weights default to
 * {high:0, normal:1, soft:2}; pass a full OrderingPolicyConfig to
 * use canon-configured weights (read via readOrderingPolicy).
 */
export function defaultOrdering(
  deadlineImminentThresholdMs: number,
  policy: OrderingPolicyConfig = DEFAULT_ORDERING_POLICY,
): OrderingFn {
  const urgencyRank = policy.urgency_weights;
  return (a: InboxMessage, b: InboxMessage, nowMs: number) => {
    const aImminent = isDeadlineImminent(a, nowMs, deadlineImminentThresholdMs) ? 0 : 1;
    const bImminent = isDeadlineImminent(b, nowMs, deadlineImminentThresholdMs) ? 0 : 1;
    if (aImminent !== bImminent) return aImminent - bImminent;

    const ua = urgencyRank[a.envelope.urgency_tier];
    const ub = urgencyRank[b.envelope.urgency_tier];
    if (ua !== ub) return ua - ub;

    // Arrival: oldest first (FIFO within the same priority tier).
    return a.atom.created_at.localeCompare(b.atom.created_at);
  };
}

function isDeadlineImminent(
  msg: InboxMessage,
  nowMs: number,
  thresholdMs: number,
): boolean {
  const deadline = msg.envelope.deadline_ts;
  if (deadline === undefined) return false;
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) return false;
  return deadlineMs - nowMs <= thresholdMs;
}

// Re-exports so consumers don't need a separate import.
export type { InboxMessage } from './inbox-reader.js';
export { listUnread, emitAck } from './inbox-reader.js';
// Time is re-exported to ease caller destructuring when constructing
// deadline_ts values.
export type { Time };
