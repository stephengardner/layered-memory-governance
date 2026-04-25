/**
 * pol-replay-tier: per-principal or per-actor-type replay-tier policy.
 *
 * Drives how much determinism the agent loop captures per session.
 * Resolution order: target_principal -> target_actor_type -> default.
 *
 * Fail-closed discipline
 * ----------------------
 * The loader mirrors the discipline applied to every other policy
 * read in this codebase:
 *
 *   1. Missing atom    -> null -> caller uses REPLAY_TIER_DEFAULT.
 *   2. Tainted atom    -> null -> default. (a compromised policy must
 *                                 not silently widen replay capture.)
 *   3. Superseded atom -> null -> default.
 *   4. Malformed       -> throw, so a canon edit that produces an
 *                                 unparsable policy fails loud rather
 *                                 than silently picking the default.
 *
 * Null is "no policy found"; the caller treats it as "use the
 * framework default", which is `content-addressed`. We never INFER a
 * tier from a malformed atom.
 */

import type { AtomStore } from '../interface.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  ReplayTier,
} from '../types.js';

/** Default tier when no policy applies. */
export const REPLAY_TIER_DEFAULT: ReplayTier = 'content-addressed';

const VALID_TIERS: ReadonlySet<ReplayTier> = new Set(['best-effort', 'content-addressed', 'strict']);

export class ReplayTierPolicyError extends Error {
  constructor(message: string, public readonly atomId?: AtomId) {
    super(`pol-replay-tier: ${message}`);
    this.name = 'ReplayTierPolicyError';
  }
}

export interface ReplayTierTarget {
  readonly target_principal?: PrincipalId;
  readonly target_actor_type?: string;
}

/**
 * Compute the canonical atom id for a replay-tier policy atom.
 * Throws if neither principal nor actor-type is provided (callers must
 * pick one; the resolver tries them in order).
 */
export function replayTierAtomId(target: ReplayTierTarget): AtomId {
  if (target.target_principal !== undefined) {
    return `pol-replay-tier-principal-${String(target.target_principal)}` as AtomId;
  }
  if (target.target_actor_type !== undefined) {
    return `pol-replay-tier-actor-${target.target_actor_type}` as AtomId;
  }
  throw new ReplayTierPolicyError('replayTierAtomId requires target_principal or target_actor_type');
}

/**
 * Resolve the effective replay tier for a (principal, actor_type) pair.
 * Returns REPLAY_TIER_DEFAULT when no policy applies.
 *
 * Resolution order:
 *   1. Per-principal policy (most specific).
 *   2. Per-actor-type policy.
 *   3. Framework default.
 */
export async function loadReplayTier(
  atoms: AtomStore,
  principal: PrincipalId,
  actorType: string,
): Promise<ReplayTier> {
  const principalRef = await atoms.get(replayTierAtomId({ target_principal: principal }));
  if (principalRef !== null) {
    const tier = parseReplayTierAtom(principalRef);
    if (tier !== null) return tier;
  }
  const actorRef = await atoms.get(replayTierAtomId({ target_actor_type: actorType }));
  if (actorRef !== null) {
    const tier = parseReplayTierAtom(actorRef);
    if (tier !== null) return tier;
  }
  return REPLAY_TIER_DEFAULT;
}

function parseReplayTierAtom(atom: Atom): ReplayTier | null {
  if (atom.taint !== 'clean') return null;
  if (atom.superseded_by.length > 0) return null;
  const md = atom.metadata as Record<string, unknown>;
  if (md['kind'] !== 'pol-replay-tier') {
    throw new ReplayTierPolicyError(`atom metadata.kind != 'pol-replay-tier'`, atom.id);
  }
  const tier = md['tier'];
  if (typeof tier !== 'string' || !VALID_TIERS.has(tier as ReplayTier)) {
    throw new ReplayTierPolicyError(`invalid tier value: ${String(tier)}`, atom.id);
  }
  return tier as ReplayTier;
}
