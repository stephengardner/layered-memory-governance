/**
 * Composed arbiter.
 *
 * Runs the rule stack in order:
 *   1. Detect conflict (content-hash short-circuit, then LLM judge).
 *   2. Source-rank (deterministic priority ladder).
 *   3. Temporal-scope (if detector said temporal, coexist).
 *   4. Validation (registered validators re-check against ground truth).
 *   5. Escalate (notifier + human disposition).
 *
 * `applyDecision` mutates atoms per the outcome and audit-logs the decision.
 */

import type { Host } from '../substrate/interface.js';
import type { Atom, AuditEvent, PrincipalId, Time } from '../substrate/types.js';
import { detectConflict, type DetectOptions } from './detect.js';
import { escalate } from './escalation.js';
import { computePrincipalDepth } from './principal-depth.js';
import { sourceRankDecide } from './source-rank.js';
import { temporalScopeDecide } from './temporal-scope.js';
import type {
  ConflictPair,
  Decision,
  DecisionOutcome,
} from './types.js';
import {
  ValidatorRegistry,
  validationDecide,
} from './validation.js';

export interface ArbiterOptions {
  readonly principalId: PrincipalId;
  readonly validators?: ValidatorRegistry;
  readonly escalationTimeoutMs?: number;
  readonly detect?: DetectOptions;
}

export async function arbitrate(
  a: Atom,
  b: Atom,
  host: Host,
  options: ArbiterOptions,
): Promise<Decision> {
  const pair = await detectConflict(a, b, host, options.detect ?? {});

  if (pair.kind === 'none') {
    return {
      pair,
      outcome: {
        kind: 'coexist',
        reason: `detector: ${pair.explanation}`,
      },
      ruleApplied: 'none',
    };
  }

  // Rule: source-rank. Hierarchy-aware: depth from root is a tiebreaker
  // between otherwise-equal atoms so an org-level atom outranks a team-
  // or agent-level atom when layer + provenance are the same.
  const [depthA, depthB] = await Promise.all([
    computePrincipalDepth(pair.a.principal_id, host.principals),
    computePrincipalDepth(pair.b.principal_id, host.principals),
  ]);
  const sr = sourceRankDecide(pair, { depthA, depthB });
  if (sr) return { pair, outcome: sr, ruleApplied: 'source-rank' };

  // Rule: temporal scope.
  const ts = temporalScopeDecide(pair);
  if (ts) return { pair, outcome: ts, ruleApplied: 'temporal-scope' };

  // Rule: validation (only if registry has validators).
  if (options.validators && options.validators.size() > 0) {
    const v = await validationDecide(pair, options.validators, host);
    if (v) return { pair, outcome: v, ruleApplied: 'validation' };
  }

  // Rule: escalate.
  const esc = await escalate(pair, host, {
    principalId: options.principalId,
    ...(options.escalationTimeoutMs !== undefined
      ? { timeoutMs: options.escalationTimeoutMs }
      : {}),
  });
  return { pair, outcome: esc, ruleApplied: 'escalation' };
}

/**
 * Apply a decision to the store:
 *   - winner outcome: mark loser.superseded_by += winner; winner.supersedes += loser.
 *   - coexist/escalate-no-winner: no atom mutation.
 * Always audit-logs the decision.
 */
export async function applyDecision(
  decision: Decision,
  host: Host,
  principalId: PrincipalId,
): Promise<void> {
  if (decision.outcome.kind === 'winner') {
    const { winner, loser } = decision.outcome;
    await host.atoms.update(loser, { superseded_by: [winner] });
    await host.atoms.update(winner, { supersedes: [loser] });
  }

  const audit: AuditEvent = {
    kind: 'arbitration.decision',
    principal_id: principalId,
    timestamp: host.clock.now() as Time,
    refs: {
      atom_ids: [decision.pair.a.id, decision.pair.b.id],
    },
    details: {
      rule: decision.ruleApplied,
      outcome_kind: decision.outcome.kind,
      reason: decision.outcome.reason,
      conflict_kind: decision.pair.kind,
      detector_explanation: decision.pair.explanation,
    },
  };
  await host.auditor.log(audit);
}

// Re-exports for call-site ergonomics.
export { ValidatorRegistry } from './validation.js';
export { DETECT_SCHEMA, DETECT_SYSTEM } from './detect.js';
export { sourceRank } from './source-rank.js';
export type { SourceRankContext } from './source-rank.js';
export { computePrincipalDepth, MAX_PRINCIPAL_DEPTH } from './principal-depth.js';
export type { ConflictPair, Decision, DecisionOutcome };
