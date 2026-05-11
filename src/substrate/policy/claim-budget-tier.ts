/**
 * pol-claim-budget-tier: resolve a budget tier name to its canon-policy
 * `max_budget_usd` ceiling.
 *
 * Lookup is by `metadata.policy.kind === 'claim-budget-tier'` plus
 * `metadata.policy.tier === <tier>`, NOT by atom id. This is deliberate:
 * org-ceiling deployments register new tiers by writing higher-priority
 * policy atoms with the same `kind`; binding the resolver to a fixed
 * atom-id pattern would foreclose that path and break the
 * dev-substrate-not-prescription contract.
 *
 * Fail-closed discipline
 * ----------------------
 * Mirrors pol-blob-threshold and pol-replay-tier:
 *
 *   1. Missing tier         -> throw `unknown-budget-tier`. A silent
 *                              default would open a budget-bypass
 *                              surface where a typo'd tier silently
 *                              runs uncapped.
 *   2. Tainted atom         -> skipped (never participates in the
 *                              match set). A compromised policy must
 *                              not silently widen the ceiling.
 *   3. Superseded atom      -> skipped. Same reasoning.
 *   4. Malformed max value  -> throw `invalid-budget-tier-config`.
 *                              Negative, non-finite, or non-number
 *                              max_budget_usd is a canon authoring bug
 *                              that must fail loud.
 *
 * The resolver is pure: no atom writes, no side effects beyond
 * AtomStore reads.
 *
 * Resolution under multiple matches
 * ---------------------------------
 * When >1 clean unsuperseded atom carries the same `tier`, the most
 * recently created one wins (created_at desc). This matches the
 * priority-then-recency tie-break used by checkToolPolicy and keeps
 * the substrate semantics consistent across policy readers.
 */

import type { Host } from '../interface.js';
import type { Atom, AtomId } from '../types.js';

export class ClaimBudgetTierPolicyError extends Error {
  constructor(message: string, public readonly atomId?: AtomId) {
    super(`pol-claim-budget-tier: ${message}`);
    this.name = 'ClaimBudgetTierPolicyError';
  }
}

// Defence against unbounded atom stores: cap the pagination walk at a
// large-but-finite number of pages. Without PAGE_LIMIT a buggy adapter
// that returns a non-advancing cursor would hang the resolver. Matches
// claim-reaper-config and src/runtime/loop/claim-reaper.ts so all
// readers give up at the same scale.
const PAGE_SIZE = 200;
const PAGE_LIMIT = 200;

/**
 * Resolve a budget tier name to its canon-policy `max_budget_usd`.
 *
 * @param tier - the tier name (e.g. 'default', 'raised', 'max',
 *               'emergency'). Case-sensitive; matches the `tier`
 *               string on the policy atom's metadata.policy block.
 * @param host - the LAG Host bundle. Only `host.atoms` is consulted.
 * @returns the ceiling in USD as a non-negative finite number.
 * @throws ClaimBudgetTierPolicyError carrying `unknown-budget-tier`
 *         when no matching clean unsuperseded policy atom is found.
 * @throws ClaimBudgetTierPolicyError carrying
 *         `invalid-budget-tier-config` when the matched policy atom
 *         carries a malformed `max_budget_usd` value.
 */
export async function resolveBudgetTier(tier: string, host: Host): Promise<number> {
  // Paginate through ALL L3 atoms. Partial pagination would mean a
  // budget-tier policy sitting beyond the first page could be silently
  // missed, producing an `unknown-budget-tier` throw on a tier that
  // actually has canon backing.
  let cursor: string | undefined = undefined;
  let best: { atom: Atom; createdAt: string } | null = null;
  for (let i = 0; i < PAGE_LIMIT; i++) {
    const page = await host.atoms.query({ layer: ['L3'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      // In-code taint + superseded guards: a compromised or superseded
      // policy atom must not participate in the match set. Do not rely
      // on AtomFilter predicates; enforcement varies across adapters.
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      // Canonical-shape filter: a budget-tier policy MUST carry both
      // `type='directive'` AND `provenance.kind='operator-seeded'`.
      // Without these gates, any sub-agent that writes a
      // non-directive `agent-inferred` atom with the matching
      // metadata.policy.kind + tier could override the
      // operator-seeded ceiling at L3. The seed shape produced by
      // bootstrap-claim-contract-canon.mjs uses type='directive' +
      // provenance.kind='operator-seeded'; either field changing in
      // the seeder must be mirrored here so the resolver and the
      // bootstrap stay in lockstep. Defence-in-depth: the type gate
      // closes a class of forgery where a preference- or decision-
      // shaped atom carries the same metadata.policy.kind/tier values.
      if (atom.type !== 'directive') continue;
      if (atom.provenance.kind !== 'operator-seeded') continue;
      const policy = (atom.metadata as Record<string, unknown>)['policy'];
      if (!policy || typeof policy !== 'object') continue;
      const p = policy as Record<string, unknown>;
      if (p['kind'] !== 'claim-budget-tier') continue;
      if (p['tier'] !== tier) continue;
      // Most-recent-wins tie-break (mirrors checkToolPolicy).
      if (best === null || atom.created_at > best.createdAt) {
        best = { atom, createdAt: atom.created_at };
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  if (best === null) {
    throw new ClaimBudgetTierPolicyError(`unknown-budget-tier: ${tier}`);
  }
  const policy = (best.atom.metadata as Record<string, unknown>)['policy'] as Record<string, unknown>;
  const usd = policy['max_budget_usd'];
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
    throw new ClaimBudgetTierPolicyError(
      `invalid-budget-tier-config: ${tier} max_budget_usd must be a non-negative finite number, got ${String(usd)}`,
      best.atom.id,
    );
  }
  return usd;
}
