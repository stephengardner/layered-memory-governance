/**
 * Atom builder for the kill-switch-tripped observation.
 *
 * Written by the actor runner when a kill-switch trip halts the
 * loop. L1 observation, discriminated by metadata.kind so the
 * AtomType surface does not grow for every new observation
 * subtype. Distinct per trip: each trip is a fresh observation,
 * the id encodes a timestamp, multiple trips on the same
 * (actor, principal) tuple land as separate atoms.
 *
 * The actor loop is the caller, not a generic consumer - the
 * atom carries the exact runtime state at trip time (iteration,
 * phase, in-flight tool) so an auditor can reconstruct what was
 * interrupted without joining against the audit log.
 */

import { randomBytes } from 'node:crypto';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../substrate/types.js';

export type KillSwitchTripPhase =
  | 'observe'
  | 'classify'
  | 'propose'
  | 'apply'
  | 'between-iterations';

export type KillSwitchTripTrigger =
  | 'stop-sentinel'
  | 'parent-signal'
  | 'deadline';

export interface MkKillSwitchTrippedAtomInputs {
  readonly actor: string;
  readonly principalId: PrincipalId;
  readonly trigger: KillSwitchTripTrigger;
  readonly trippedAt: Time;
  readonly iteration: number;
  readonly phase: KillSwitchTripPhase;
  readonly sessionId: string;
  readonly inFlightTool?: string;
  readonly revocationNotes?: string;
  /**
   * Nonce suffix on the generated atom id. Omit in production
   * (a fresh random 6-hex nonce is generated per call). Supply
   * in tests that want to assert on the exact id without
   * mocking crypto.
   */
  readonly idNonce?: string;
}

/**
 * Id that distinguishes every trip. The ISO timestamp alone is
 * not a safe uniqueness key: coarse host clocks (some OSes tick
 * at 10-15 ms) can produce two calls with identical `trippedAt`,
 * and deterministic test clocks do so by design. A 6-hex nonce
 * (24 bits, ~1e-7 collision per duplicate-timestamp pair) is
 * appended so repeated trips on the same (actor, principal)
 * always land as distinct atoms.
 *
 * Passing `nonce` explicitly lets callers reproduce a specific
 * id in tests; omit it in production and let the default random
 * bytes run.
 */
export function mkKillSwitchTrippedAtomId(
  actor: string,
  principalId: PrincipalId,
  trippedAt: Time,
  nonce: string = randomBytes(3).toString('hex'),
): AtomId {
  return `kill-switch-tripped-${actor}-${String(principalId)}-${trippedAt}-${nonce}` as AtomId;
}

export function mkKillSwitchTrippedAtom(
  inputs: MkKillSwitchTrippedAtomInputs,
): Atom {
  const {
    actor,
    principalId,
    trigger,
    trippedAt,
    iteration,
    phase,
    sessionId,
    inFlightTool,
    revocationNotes,
  } = inputs;

  const metadata: Record<string, unknown> = {
    kind: 'kill-switch-tripped',
    actor,
    principal_id: String(principalId),
    tripped_by: trigger,
    tripped_at: trippedAt,
    iteration,
    phase,
  };
  if (inFlightTool !== undefined) metadata['in_flight_tool'] = inFlightTool;
  if (revocationNotes !== undefined) metadata['revocation_notes'] = revocationNotes;

  const id = inputs.idNonce !== undefined
    ? mkKillSwitchTrippedAtomId(actor, principalId, trippedAt, inputs.idNonce)
    : mkKillSwitchTrippedAtomId(actor, principalId, trippedAt);

  return {
    schema_version: 1,
    id,
    content: renderKillSwitchTrippedContent(inputs),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: String(principalId),
        tool: 'kill-switch-revocation',
        session_id: sessionId,
      },
      derived_from: [],
    },
    confidence: 1.0,
    created_at: trippedAt,
    last_reinforced_at: trippedAt,
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
    principal_id: principalId,
    taint: 'clean',
    metadata,
  };
}

function renderKillSwitchTrippedContent(
  inputs: MkKillSwitchTrippedAtomInputs,
): string {
  const lines: string[] = [];
  lines.push(`kill-switch tripped for ${inputs.actor} (principal ${String(inputs.principalId)})`);
  lines.push(`trigger: ${inputs.trigger}`);
  lines.push(`tripped_at: ${inputs.trippedAt}`);
  lines.push(`iteration: ${inputs.iteration}`);
  lines.push(`phase: ${inputs.phase}`);
  if (inputs.inFlightTool !== undefined) {
    lines.push(`in_flight_tool: ${inputs.inFlightTool}`);
  }
  if (inputs.revocationNotes !== undefined) {
    lines.push('');
    lines.push(inputs.revocationNotes);
  }
  return lines.join('\n');
}
