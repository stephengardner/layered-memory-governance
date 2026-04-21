/**
 * Inbox ordering configuration, read from a policy atom.
 *
 * The framework ships a deterministic default ordering in pickup.ts
 * (deadline-imminent > urgency > arrival). Deployments can tune the
 * knobs that default ordering exposes (the imminent-deadline
 * threshold, the urgency tier weights) by editing
 * pol-inbox-ordering's metadata.policy fields, NOT by shipping a
 * new framework release. Per dev-substrate-not-prescription.
 *
 * Callers that want an entirely different ordering function keep
 * passing a custom orderingFn to pickNextMessage; this module only
 * parameterizes the DEFAULT function.
 */

import type { Host } from '../substrate/interface.js';

export interface OrderingPolicyConfig {
  /**
   * ms threshold that treats a deadline as "imminent" for ordering.
   * Default 60_000; overridable via pol-inbox-ordering.policy.
   */
  readonly deadline_imminent_threshold_ms: number;
  /**
   * Urgency tier weights. Lower value = higher priority. Default:
   * high=0, normal=1, soft=2. A deployment that wants to invert
   * "high" and "normal" (say, to treat high as a rate-limited
   * privilege) can edit the weights via canon without a framework
   * release.
   */
  readonly urgency_weights: Readonly<{
    high: number;
    normal: number;
    soft: number;
  }>;
}

export const DEFAULT_ORDERING_POLICY: OrderingPolicyConfig = Object.freeze({
  deadline_imminent_threshold_ms: 60_000,
  urgency_weights: Object.freeze({ high: 0, normal: 1, soft: 2 }),
});

/**
 * Read the inbox ordering policy from the AtomStore. Falls back to
 * DEFAULT_ORDERING_POLICY when the atom is missing, tainted, or
 * superseded (fail-closed, like every other policy read in this
 * module - a compromised or missing ordering atom should never
 * silently invert priority).
 */
export async function readOrderingPolicy(host: Host): Promise<OrderingPolicyConfig> {
  const page = await host.atoms.query({ type: ['directive'], layer: ['L3'] }, 200);
  for (const atom of page.atoms) {
    if (atom.taint !== 'clean') continue;
    if (atom.superseded_by.length > 0) continue;
    const policy = (atom.metadata as Record<string, unknown>)?.policy as
      | Record<string, unknown>
      | undefined;
    if (policy?.subject !== 'inbox-ordering') continue;

    const threshold = Number(policy.deadline_imminent_threshold_ms);
    const weightsRaw = policy.urgency_weights as Record<string, unknown> | undefined;
    const high = Number(weightsRaw?.high);
    const normal = Number(weightsRaw?.normal);
    const soft = Number(weightsRaw?.soft);

    const validThreshold = Number.isFinite(threshold) && threshold >= 0
      ? threshold
      : DEFAULT_ORDERING_POLICY.deadline_imminent_threshold_ms;
    const validWeights = [high, normal, soft].every((n) => Number.isFinite(n))
      ? { high, normal, soft }
      : DEFAULT_ORDERING_POLICY.urgency_weights;

    return {
      deadline_imminent_threshold_ms: validThreshold,
      urgency_weights: validWeights,
    };
  }
  return DEFAULT_ORDERING_POLICY;
}
