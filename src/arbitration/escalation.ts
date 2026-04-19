/**
 * Escalation rule.
 *
 * When the rule stack cannot decide, ask a human (or a higher-authority
 * agent) via the Notifier. Disposition semantics for arbitration:
 *   - approve: pair.a wins (newer or first-argument convention)
 *   - reject: pair.b wins
 *   - ignore | timeout: no decision; atoms coexist
 *
 * The choice of approve=a is a convention. Callers that prefer a different
 * meaning can wrap escalation with their own semantics.
 */

import type { Host } from '../interface.js';
import type { Event, PrincipalId } from '../types.js';
import type { ConflictPair, DecisionOutcome } from './types.js';

export interface EscalationOptions {
  readonly principalId: PrincipalId;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function escalate(
  pair: ConflictPair,
  host: Host,
  options: EscalationOptions,
): Promise<DecisionOutcome> {
  const event: Event = {
    kind: 'anomaly',
    severity: 'warn',
    summary: `Arbitration escalation: ${String(pair.a.id)} vs ${String(pair.b.id)}`,
    body:
      `Conflict kind: ${pair.kind}\n` +
      `Explanation: ${pair.explanation}\n\n` +
      `Atom A (${String(pair.a.id)}, ${pair.a.layer}, ${pair.a.provenance.kind}):\n` +
      `  ${pair.a.content}\n\n` +
      `Atom B (${String(pair.b.id)}, ${pair.b.layer}, ${pair.b.provenance.kind}):\n` +
      `  ${pair.b.content}\n\n` +
      `Convention: approve = A wins, reject = B wins, ignore/timeout = coexist.`,
    atom_refs: [pair.a.id, pair.b.id],
    principal_id: options.principalId,
    created_at: host.clock.now(),
  };

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const handle = await host.notifier.telegraph(event, null, 'timeout', timeoutMs);
  const disposition = await host.notifier.awaitDisposition(handle, timeoutMs);

  if (disposition === 'approve') {
    return {
      kind: 'winner',
      winner: pair.a.id,
      loser: pair.b.id,
      reason: 'escalation: human approved A',
    };
  }
  if (disposition === 'reject') {
    return {
      kind: 'winner',
      winner: pair.b.id,
      loser: pair.a.id,
      reason: 'escalation: human rejected A (B wins)',
    };
  }
  // pending | ignore | timeout
  return {
    kind: 'coexist',
    reason: `escalation ${disposition}: no decision, atoms coexist`,
  };
}
