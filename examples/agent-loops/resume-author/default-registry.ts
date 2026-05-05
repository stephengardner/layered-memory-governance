/**
 * Default `ResumeStrategyRegistry` for the indie-floor LAG host.
 *
 * Phase 2 (PR #307) wired the cto-actor and code-author descriptors
 * from `cto-actor-strategy.ts` and `code-author-strategy.ts`. Phase 3
 * (this PR) adds `pr-fix-actor` from `pr-fix-actor-strategy.ts` so the
 * canonical three-actor set (cto-actor, code-author, pr-fix-actor)
 * registers in one call. The registry primitive itself is unchanged
 * from PR #305; this file is the per-host composition that says
 * "these are the actors my host knows about by default."
 *
 * Per spec section 9.2 the registry is a runner-side construct -
 * each runner script (`run-cto-actor.mjs`, `run-code-author.mjs`,
 * `run-pr-fix.mjs`, etc.) constructs the registry, registers the
 * descriptors it cares about, and calls `wrapIfEnabled` to produce
 * the adapter it passes to the actor. `buildDefaultRegistry` is the
 * convenience constructor for the common case where a host wants the
 * full set of canonical descriptors registered together.
 *
 * Indie-floor / org-ceiling fit (per `dev-indie-floor-org-ceiling`):
 *   - Indie deployments call `buildDefaultRegistry(host)` once,
 *     during host bootstrap, and pass the registry to every runner.
 *     Per-actor resume stays opt-in via the canon policy atom
 *     `pol-resume-strategy-<principal-id>` per spec section 5; the
 *     registry's role is registration, not enablement.
 *   - Org-ceiling deployments add their own descriptors with
 *     `addDescriptor(registry, ...)` after calling
 *     `buildDefaultRegistry`, OR construct a fresh registry via
 *     `createResumeStrategyRegistry` and register the subset of
 *     canonical + custom descriptors they want.
 *
 * The `host` parameter is accepted to keep the seam future-compatible
 * with host-aware descriptor variants (e.g. a descriptor that closes
 * over the host's clock or auditor for capture). Phase 2 descriptors
 * are pure (no host dependency) so the parameter is currently
 * unused; declaring it now avoids a breaking-change at the call site
 * when host-aware descriptors land.
 */

import type { Host } from '../../../src/substrate/interface.js';
import {
  CODE_AUTHOR_PRINCIPAL_ID,
  CODE_AUTHOR_WORK_ITEM_KEY_PREFIXES,
  codeAuthorResumeStrategyDescriptor,
} from './code-author-strategy.js';
import {
  CTO_ACTOR_PRINCIPAL_ID,
  CTO_ACTOR_WORK_ITEM_KEY_PREFIXES,
  ctoActorResumeStrategyDescriptor,
} from './cto-actor-strategy.js';
import {
  PR_FIX_ACTOR_PRINCIPAL_ID,
  PR_FIX_ACTOR_WORK_ITEM_KEY_PREFIXES,
  prFixActorResumeStrategyDescriptor,
} from './pr-fix-actor-strategy.js';
import {
  addDescriptor,
  createResumeStrategyRegistry,
  type PrincipalId as RegistryPrincipalId,
  type ResumeStrategyDescriptor,
  type ResumeStrategyRegistry,
} from './registry.js';

/**
 * Construct a fresh registry and register the canonical Phase 3
 * descriptors (`cto-actor`, `code-author`, and `pr-fix-actor`).
 *
 * Returns the populated registry. Callers that want to extend the
 * default set add their own descriptors via `addDescriptor` on the
 * returned registry; callers that want a different subset construct
 * a fresh registry via `createResumeStrategyRegistry` directly.
 *
 * The `host` parameter is reserved for future host-aware descriptor
 * variants and is intentionally unused in Phase 3; the parameter
 * declaration documents the seam without populating it.
 */
export function buildDefaultRegistry(_host: Host): ResumeStrategyRegistry {
  const registry = createResumeStrategyRegistry();
  // The Phase 1 registry's PrincipalId is locally branded
  // (`__principalIdBrand`) and intentionally distinct from the
  // substrate's PrincipalId (`__brand: 'PrincipalId'`). At runtime
  // both are plain strings, so the brand-bridging cast is safe; the
  // narrow cast localizes the boundary so no other call site needs
  // to know about the dual-brand quirk.
  addDescriptor(
    registry,
    CTO_ACTOR_PRINCIPAL_ID as unknown as RegistryPrincipalId,
    ctoActorResumeStrategyDescriptor as ResumeStrategyDescriptor,
    CTO_ACTOR_WORK_ITEM_KEY_PREFIXES,
  );
  addDescriptor(
    registry,
    CODE_AUTHOR_PRINCIPAL_ID as unknown as RegistryPrincipalId,
    codeAuthorResumeStrategyDescriptor as ResumeStrategyDescriptor,
    CODE_AUTHOR_WORK_ITEM_KEY_PREFIXES,
  );
  addDescriptor(
    registry,
    PR_FIX_ACTOR_PRINCIPAL_ID as unknown as RegistryPrincipalId,
    prFixActorResumeStrategyDescriptor as ResumeStrategyDescriptor,
    PR_FIX_ACTOR_WORK_ITEM_KEY_PREFIXES,
  );
  return registry;
}
