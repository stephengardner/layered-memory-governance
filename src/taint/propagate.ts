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

import type { Host } from '../substrate/interface.js';
import type { Atom, AtomId, PrincipalId, Time } from '../substrate/types.js';
import { NotFoundError } from '../substrate/errors.js';

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

  const taintedIds = new Set<AtomId>();
  let atomsScanned = 0;
  let iterations = 0;

  // --- Iteration 0: direct taints from the compromised principal ----------
  iterations += 1;
  const direct = await host.atoms.query(
    { principal_id: [principalId], superseded: true },
    pageSize,
  );
  atomsScanned += direct.atoms.length;
  for (const atom of direct.atoms) {
    if (atom.created_at < compromisedAt) continue; // written before compromise
    if (atom.taint !== 'clean') continue; // already tainted/quarantined
    await applyTaint(host, atom, principalId, responderId, 'direct');
    taintedIds.add(atom.id);
  }

  // --- Iterate transitive propagation to fixpoint -------------------------
  while (iterations < maxIterations) {
    iterations += 1;
    let newlyTainted = 0;
    // Scan all atoms (bounded by pageSize). For the V0 scale this is fine;
    // if the palace grows, this is the place to add a derived_from -> atom_id
    // index on the AtomStore.
    const page = await host.atoms.query({ superseded: true }, pageSize);
    atomsScanned += page.atoms.length;
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.provenance.derived_from.length === 0) continue;
      const sourcesTainted = atom.provenance.derived_from.some(id =>
        taintedIds.has(id),
      );
      if (!sourcesTainted) continue;
      await applyTaint(host, atom, principalId, responderId, 'transitive');
      taintedIds.add(atom.id);
      newlyTainted += 1;
    }
    if (newlyTainted === 0) break;
  }

  return {
    principalId,
    compromisedAt,
    atomsTainted: taintedIds.size,
    atomsScanned,
    iterations,
    taintedAtomIds: Object.freeze([...taintedIds]),
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
