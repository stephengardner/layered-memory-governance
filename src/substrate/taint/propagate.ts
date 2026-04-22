/**
 * Compromise taint propagation.
 *
 * When a principal is marked compromised (via PrincipalStore.markCompromised),
 * atoms they wrote at/after the compromise time are no longer trustworthy.
 * Every downstream atom (via `provenance.derived_from`) that transitively
 * sourced from one of those atoms inherits the taint.
 *
 * This module exposes a single entry point:
 *   propagateCompromiseTaint(host, principalId, responderId): Promise<TaintReport>
 *
 * Effect:
 *   - Direct: any atom where principal_id === principalId AND
 *     created_at >= principal.compromised_at becomes taint='tainted'.
 *   - Transitive: any atom whose derived_from chain reaches a tainted atom
 *     also becomes tainted. Iterated to fixpoint.
 *   - Side-effect-free on the principal record itself.
 *   - Every transition is logged as an audit event (kind='atom.tainted').
 *   - Idempotent: atoms already tainted/quarantined are left alone.
 *
 * What this does NOT do:
 *   - Delete or supersede atoms. Tainted atoms remain queryable (for audit).
 *   - Revoke canon. The canon generator filters taint !== 'clean' on render;
 *     next canon-applier pass naturally expunges tainted entries.
 *   - Untaint: a separate operation, not provided here. Taint propagation
 *     is fail-safe; a false-positive compromise should be un-marked on the
 *     principal, and tainted atoms re-examined manually.
 */

import type { Host } from '../interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../types.js';
import { NotFoundError } from '../errors.js';

export interface TaintReport {
  readonly principalId: PrincipalId;
  readonly compromisedAt: Time;
  /** Atoms newly transitioned clean -> tainted. */
  readonly atomsTainted: number;
  /** Total atoms inspected across all iterations. */
  readonly atomsScanned: number;
  /** Fixpoint iteration count (1 = no transitive propagation needed). */
  readonly iterations: number;
  /** Set of atom IDs that transitioned during this invocation. */
  readonly taintedAtomIds: ReadonlyArray<AtomId>;
}

export interface PropagateOptions {
  /**
   * Max iterations for transitive propagation. Safety ceiling; real graphs
   * should converge in a handful of passes. Default 20.
   */
  readonly maxIterations?: number;
  /** Page size when scanning atoms. Default 10_000. */
  readonly pageSize?: number;
}

export async function propagateCompromiseTaint(
  host: Host,
  principalId: PrincipalId,
  responderId: PrincipalId,
  options: PropagateOptions = {},
): Promise<TaintReport> {
  const maxIterations = options.maxIterations ?? 20;
  const pageSize = options.pageSize ?? 10_000;

  const principal = await host.principals.get(principalId);
  if (!principal) {
    throw new NotFoundError(`Principal ${String(principalId)} not found`);
  }
  if (principal.compromised_at === null) {
    // Nothing to do; principal is not marked compromised.
    return {
      principalId,
      compromisedAt: '' as Time,
      atomsTainted: 0,
      atomsScanned: 0,
      iterations: 0,
      taintedAtomIds: [],
    };
  }
  const compromisedAt = principal.compromised_at;

  // Split the set semantics so reruns are idempotent:
  // - reachableTaintedIds: every tainted atom the scan sees (including
  //   already-tainted ones from prior partial runs). Used to drive
  //   transitive propagation so a clean descendant of a partially-
  //   tainted ancestor is still caught on rerun.
  // - newlyTaintedIds: atoms this invocation transitioned clean ->
  //   tainted. This is what we report in the TaintReport so the
  //   "idempotent: rerun produces zero new transitions" contract holds.
  const reachableTaintedIds = new Set<AtomId>();
  const newlyTaintedIds = new Set<AtomId>();
  let atomsScanned = 0;
  let iterations = 0;

  // --- Iteration 0: direct taints from the compromised principal ----------
  // Paginate through EVERY atom authored by the compromised principal.
  // AtomStore.query is cursor-paginated, so only reading the first page
  // would leave atoms past pageSize silently clean - a false negative
  // with taint-leak consequences. Also add an explicit in-code
  // principal_id check because AtomFilter enforcement varies across
  // adapters (some ignore filters); belt + suspenders.
  iterations += 1;
  {
    let cursor: string | undefined = undefined;
    for (;;) {
      const page = await host.atoms.query(
        { principal_id: [principalId], superseded: true },
        pageSize,
        cursor,
      );
      atomsScanned += page.atoms.length;
      for (const atom of page.atoms) {
        if (atom.principal_id !== principalId) continue; // filter-defence guard
        if (atom.created_at < compromisedAt) continue; // written before compromise
        if (atom.taint !== 'clean') {
          // Already tainted/quarantined from a prior partial run - still
          // seed it so transitive propagation continues from here. A clean
          // descendant authored by a different principal after a partial
          // run would otherwise be missed on rerun. Do NOT add to
          // newlyTaintedIds - no new transition happened.
          reachableTaintedIds.add(atom.id);
          continue;
        }
        await applyTaint(host, atom, principalId, responderId, 'direct');
        reachableTaintedIds.add(atom.id);
        newlyTaintedIds.add(atom.id);
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }

  // --- Iterate transitive propagation to fixpoint -------------------------
  while (iterations < maxIterations) {
    iterations += 1;
    let newlyTainted = 0;
    // Scan all atoms, paginating through EVERY page. For the V0 scale
    // this is fine; if the palace grows, this is the place to add a
    // derived_from -> atom_id index on the AtomStore.
    let cursor: string | undefined = undefined;
    for (;;) {
      const page = await host.atoms.query({ superseded: true }, pageSize, cursor);
      atomsScanned += page.atoms.length;
      for (const atom of page.atoms) {
        if (atom.provenance.derived_from.length === 0) continue;
        const sourcesTainted = atom.provenance.derived_from.some(id =>
          reachableTaintedIds.has(id),
        );
        if (!sourcesTainted) continue;
        if (atom.taint !== 'clean') {
          // Already tainted; still track the id so a further descendant
          // off this atom continues to propagate in the next iteration.
          // Do NOT add to newlyTaintedIds - no transition happened.
          if (!reachableTaintedIds.has(atom.id)) {
            reachableTaintedIds.add(atom.id);
            newlyTainted += 1; // new source-of-propagation this iteration
          }
          continue;
        }
        await applyTaint(host, atom, principalId, responderId, 'transitive');
        reachableTaintedIds.add(atom.id);
        newlyTaintedIds.add(atom.id);
        newlyTainted += 1;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    if (newlyTainted === 0) break;
  }

  return {
    principalId,
    compromisedAt,
    // "atomsTainted" reports transitions this run, not the total reachable
    // tainted set. Idempotency contract: a rerun with nothing new to
    // transition returns 0 here.
    atomsTainted: newlyTaintedIds.size,
    atomsScanned,
    iterations,
    taintedAtomIds: Object.freeze([...newlyTaintedIds]),
  };
}

async function applyTaint(
  host: Host,
  atom: Atom,
  triggerPrincipal: PrincipalId,
  responderId: PrincipalId,
  mode: 'direct' | 'transitive',
): Promise<void> {
  await host.atoms.update(atom.id, { taint: 'tainted' });
  await host.auditor.log({
    kind: 'atom.tainted',
    principal_id: responderId,
    timestamp: host.clock.now() as Time,
    refs: { atom_ids: [atom.id] },
    details: {
      mode,
      trigger_principal: triggerPrincipal,
      prior_taint: atom.taint,
      atom_layer: atom.layer,
      atom_type: atom.type,
      atom_principal: atom.principal_id,
    },
  });
}
