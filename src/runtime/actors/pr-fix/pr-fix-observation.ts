/**
 * pr-fix-observation atom builder + content renderer + id generator.
 *
 * Mechanism: writes one atom per `PrFixActor.observe()` pass. The atom
 * captures the structurally-fixed snapshot (counts, classification,
 * mergeable state) the actor classified on. Subsequent writes chain
 * via `provenance.derived_from` to the prior observation for the same
 * PR, so consumers can walk the chain without scanning the whole
 * store.
 *
 * `dispatched_session_atom_id` is patched onto the atom AFTER `apply()`
 * runs (via `host.atoms.update`); the initial atom written in
 * `observe()` does not have it set unless the caller passes it here.
 *
 * This module is mechanism-only: no design refs, no actor-instance
 * shape names beyond the bare types it must touch.
 */

import { randomBytes } from 'node:crypto';
import type {
  Atom,
  AtomId,
  PrincipalId,
  PrFixObservationMeta,
} from '../../../substrate/types.js';

export function mkPrFixObservationAtom(input: {
  readonly principal: PrincipalId;
  readonly observationId: AtomId;
  readonly meta: PrFixObservationMeta;
  readonly priorObservationAtomId: AtomId | undefined;
  readonly dispatchedSessionAtomId: AtomId | undefined;
  readonly now: string;
}): Atom {
  const derived: AtomId[] = [];
  if (input.priorObservationAtomId !== undefined) {
    derived.push(input.priorObservationAtomId);
  }
  if (input.dispatchedSessionAtomId !== undefined) {
    derived.push(input.dispatchedSessionAtomId);
  }
  const m: PrFixObservationMeta =
    input.dispatchedSessionAtomId !== undefined
      ? { ...input.meta, dispatched_session_atom_id: input.dispatchedSessionAtomId }
      : input.meta;
  return {
    schema_version: 1,
    id: input.observationId,
    content: renderObservationContent(input.meta),
    type: 'pr-fix-observation',
    layer: 'L0',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: input.principal as unknown as string },
      derived_from: derived,
    },
    confidence: 1,
    created_at: input.now,
    last_reinforced_at: input.now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: input.principal,
    taint: 'clean',
    metadata: { pr_fix_observation: m },
  };
}

/**
 * Single render so atom-content + any downstream display can not drift.
 * Output is deterministic given a `PrFixObservationMeta`.
 */
export function renderObservationContent(meta: PrFixObservationMeta): string {
  return (
    `pr-fix observation: PR ${meta.pr_owner}/${meta.pr_repo}#${meta.pr_number}` +
    ` head=${meta.head_sha.slice(0, 7)}` +
    ` classification=${meta.classification}` +
    ` line_comments=${meta.line_comment_count}` +
    ` body_nits=${meta.body_nit_count}`
  );
}

/**
 * Default id generator. Callers that do not supply an explicit
 * `observationId` use this. Uses `randomBytes` (cryptographic RNG, same
 * pattern as `mkCodeAuthorInvokedAtomId`) for collision safety.
 */
export function mkPrFixObservationAtomId(prefix: string = 'pr-fix-obs'): AtomId {
  const nonce = randomBytes(6).toString('hex');
  return `${prefix}-${nonce}` as AtomId;
}
