/**
 * aggregateRelevantContext: gather the atom-set snapshot the
 * PlanningActor reasons over for a given request.
 *
 * Pure(ish) helper: takes a Host + request + optional caps, reads
 * via host.atoms query/search, returns a PlanningContext. Does not
 * mutate state; does not invoke the LLM. Deterministic given the
 * same store contents.
 *
 * Reusable: any future planning-shaped actor (strategy, incident-
 * response, research-agent) can call this. Kept outside the actor
 * class so it is importable as a plain function.
 */

import type { Host } from '../../interface.js';
import type { Atom, AtomId, PrincipalId } from '../../types.js';
import type { PlanningContext } from './types.js';

export interface AggregateContextOptions {
  /** Max L3 directive atoms to include. Default 50. */
  readonly maxDirectives?: number;
  /** Max L3 decision atoms. Default 50. */
  readonly maxDecisions?: number;
  /** Top-K semantically relevant atoms across all layers. Default 20. */
  readonly topKRelevant?: number;
  /** Max open-plan atoms to surface. Default 20. */
  readonly maxOpenPlans?: number;
  /** Max relevant principals. Default 20. */
  readonly maxPrincipals?: number;
}

export async function aggregateRelevantContext(
  host: Host,
  request: string,
  options: AggregateContextOptions = {},
): Promise<PlanningContext> {
  const maxDirectives = options.maxDirectives ?? 50;
  const maxDecisions = options.maxDecisions ?? 50;
  const topKRelevant = options.topKRelevant ?? 20;
  const maxOpenPlans = options.maxOpenPlans ?? 20;
  const maxPrincipals = options.maxPrincipals ?? 20;

  // 1. All L3 directives: enforced constraints. Plans conflicting with
  //    these are escalated at validatePlan time, but the planner
  //    should see them up-front and cite what it applies.
  const directivePage = await host.atoms.query(
    { layer: ['L3'], type: ['directive'] },
    maxDirectives,
  );
  const directives = [...directivePage.atoms];

  // 2. L3 decisions: prior precedent. Analogous to DECISIONS.md rows.
  const decisionPage = await host.atoms.query(
    { layer: ['L3'], type: ['decision'] },
    maxDecisions,
  );
  const decisions = [...decisionPage.atoms];

  // 3. Top-K semantically relevant atoms for this request. Any layer,
  //    any type; the planner weighs by distance implicitly through the
  //    order (search returns best-first).
  const searchHits = await host.atoms.search(request, topKRelevant);
  const relevantAtoms: Atom[] = [];
  const seenIds = new Set<AtomId>();
  for (const hit of searchHits) {
    if (seenIds.has(hit.atom.id)) continue;
    seenIds.add(hit.atom.id);
    relevantAtoms.push(hit.atom);
  }

  // 4. Open plan atoms: what's already in flight. Used so the planner
  //    does not silently duplicate existing in-flight work.
  const planPage = await host.atoms.query(
    { type: ['plan'] },
    maxOpenPlans,
  );
  const openPlans = planPage.atoms.filter((atom) => {
    // plan_state is a top-level Atom field per src/types.ts. Fall
    // back to metadata.plan_state to stay compatible with older
    // plan atoms that were written with it in metadata before the
    // PlanningActor fix. New plans use the top-level field; the
    // compatibility read lets historical atoms continue to surface
    // in open-plan queries.
    const ps = atom.plan_state
      ?? (atom.metadata.plan_state as string | undefined);
    return ps === 'proposed' || ps === 'approved' || ps === 'executing';
  });

  // 5. Relevant principals. For MVP we pull active principals and cap
  //    at maxPrincipals; finer filtering (by role, by scope overlap)
  //    comes later when validatePlan consumes this.
  const principalList = await host.principals.listActive();
  const relevantPrincipals = principalList.slice(0, maxPrincipals).map((p) => ({
    id: p.id,
    role: p.role,
    signed_by: p.signed_by,
  }));

  return {
    request,
    directives,
    decisions,
    relevantAtoms,
    openPlans,
    relevantPrincipals,
    gatheredAt: host.clock.now(),
  };
}
