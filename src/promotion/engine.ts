/**
 * Promotion engine.
 *
 * Two entry points:
 *   - `findCandidates(layer)`: scan the store at the source layer, group by
 *     content-hash, and build PromotionCandidate records with consensus +
 *     validation.
 *   - `promote(candidate, target)`: evaluate policy. If it passes, create a
 *     new atom at the target layer with provenance.kind='canon-promoted'
 *     and derived_from=[candidate.atom.id]; mark the original superseded;
 *     audit-log. L3 additionally requires human approval via Notifier.
 *
 * The new atom's id is a deterministic hash of (source atom id, target layer)
 * so repeated promote calls on the same candidate do not create duplicates.
 */

import { createHash } from 'node:crypto';
import type { Host } from '../substrate/interface.js';
import type {
  Atom,
  AtomId,
  AuditEvent,
  Event,
  PrincipalId,
  Time,
} from '../substrate/types.js';
import { ValidatorRegistry } from '../arbitration/validation.js';
import {
  DEFAULT_THRESHOLDS,
  sourceLayerFor,
  type PromotableLayer,
  type PromotionCandidate,
  type PromotionDecision,
  type PromotionOutcome,
  type PromotionThresholds,
} from './types.js';
import { evaluate } from './policy.js';

export interface PromotionEngineOptions {
  readonly principalId: PrincipalId;
  readonly thresholds?: PromotionThresholds;
  readonly validators?: ValidatorRegistry;
  /** Escalation timeout for L3 human gate. Defaults to 60s. */
  readonly humanGateTimeoutMs?: number;
}

const DEFAULT_GATE_TIMEOUT_MS = 60_000;

export class PromotionEngine {
  constructor(
    private readonly host: Host,
    private readonly options: PromotionEngineOptions,
  ) {}

  /**
   * Build PromotionCandidates for every content-hash class at the source
   * layer. Returns one candidate per class (carrying the newest atom).
   */
  async findCandidates(
    targetLayer: PromotableLayer,
  ): Promise<PromotionCandidate[]> {
    const sourceLayer = sourceLayerFor(targetLayer);
    const { atoms } = await this.host.atoms.query({ layer: [sourceLayer] }, 100_000);
    const byHash = new Map<string, Atom[]>();
    for (const atom of atoms) {
      const h = this.host.atoms.contentHash(atom.content);
      const arr = byHash.get(h) ?? [];
      arr.push(atom);
      byHash.set(h, arr);
    }

    const candidates: PromotionCandidate[] = [];
    for (const group of byHash.values()) {
      const sorted = [...group].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const newest = sorted[0];
      if (!newest) continue;
      const principals = new Set(group.map(a => a.principal_id));
      const validation = this.options.validators
        ? await this.options.validators.validate(newest, this.host)
        : 'unverifiable';
      candidates.push({
        atom: newest,
        consensusAtoms: Object.freeze(group),
        consensusCount: principals.size,
        validation,
      });
    }
    return candidates;
  }

  /**
   * Evaluate the candidate against policy, then apply if allowed.
   * For L3, additionally gate on human approval via the Notifier.
   */
  async promote(
    candidate: PromotionCandidate,
    targetLayer: PromotableLayer,
  ): Promise<PromotionOutcome> {
    const thresholds = this.options.thresholds ?? DEFAULT_THRESHOLDS;
    const decision = evaluate(candidate, targetLayer, thresholds);

    if (!decision.canPromote) {
      await this.auditRejected(decision, 'policy');
      return {
        decision,
        kind: 'rejected-by-policy',
        promotedAtomId: null,
        reason: decision.reasons.join('; '),
      };
    }

    const thr = targetLayer === 'L2' ? thresholds.L2 : thresholds.L3;
    if (thr.requireHumanApproval) {
      const gate = await this.awaitHumanGate(decision);
      if (gate.kind !== 'promoted') {
        await this.auditGated(decision, gate);
        return gate;
      }
    }

    const newAtomId = await this.applyPromotion(decision);
    await this.auditPromoted(decision, newAtomId);
    return {
      decision,
      kind: 'promoted',
      promotedAtomId: newAtomId,
      reason: 'all policy and gates satisfied',
    };
  }

  /**
   * Convenience: find candidates and promote each that passes policy.
   * Returns outcomes in the order attempted.
   */
  async runPass(targetLayer: PromotableLayer): Promise<PromotionOutcome[]> {
    const cands = await this.findCandidates(targetLayer);
    const out: PromotionOutcome[] = [];
    for (const c of cands) {
      out.push(await this.promote(c, targetLayer));
    }
    return out;
  }

  // ---- Private ----

  private async awaitHumanGate(
    decision: PromotionDecision,
  ): Promise<PromotionOutcome> {
    const timeoutMs = this.options.humanGateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const event: Event = {
      kind: 'proposal',
      severity: 'info',
      summary: `Promote ${String(decision.candidate.atom.id)} to ${decision.targetLayer}`,
      body:
        `Candidate content: ${decision.candidate.atom.content}\n\n` +
        `Source layer: ${decision.candidate.atom.layer}\n` +
        `Consensus: ${decision.candidate.consensusCount} principals\n` +
        `Validation: ${decision.candidate.validation}\n\n` +
        `Approve (A promoted), reject (no promotion), ignore/timeout (no promotion).`,
      atom_refs: [decision.candidate.atom.id],
      principal_id: this.options.principalId,
      created_at: this.host.clock.now(),
    };
    const handle = await this.host.notifier.telegraph(event, null, 'timeout', timeoutMs);
    const disp = await this.host.notifier.awaitDisposition(handle, timeoutMs);
    if (disp === 'approve') {
      return {
        decision,
        kind: 'promoted',
        promotedAtomId: null, // filled by caller after applyPromotion
        reason: 'human approved',
      };
    }
    if (disp === 'reject') {
      return {
        decision,
        kind: 'rejected-by-human',
        promotedAtomId: null,
        reason: 'human rejected',
      };
    }
    return {
      decision,
      kind: 'timed-out-awaiting-human',
      promotedAtomId: null,
      reason: `disposition ${disp}`,
    };
  }

  /**
   * Create the promoted atom at target layer and mark the source superseded.
   * Deterministic ids prevent duplicate promotions on re-run.
   */
  private async applyPromotion(decision: PromotionDecision): Promise<AtomId> {
    const src = decision.candidate.atom;
    const newId = createHash('sha256')
      .update(String(src.id), 'utf8')
      .update('|->|', 'utf8')
      .update(decision.targetLayer, 'utf8')
      .digest('hex')
      .slice(0, 24) as AtomId;

    // Idempotent: if already promoted, return existing.
    const existing = await this.host.atoms.get(newId);
    if (existing) return newId;

    const now = this.host.clock.now();
    const promoted: Atom = {
      schema_version: src.schema_version,
      id: newId,
      content: src.content,
      type: src.type,
      layer: decision.targetLayer,
      provenance: {
        kind: 'canon-promoted',
        source: src.provenance.source,
        derived_from: Object.freeze([src.id]),
      },
      confidence: src.confidence,
      created_at: now as Time,
      last_reinforced_at: now as Time,
      expires_at: src.expires_at,
      supersedes: Object.freeze([src.id]),
      superseded_by: Object.freeze([]),
      scope: src.scope,
      signals: {
        agrees_with: src.signals.agrees_with,
        conflicts_with: src.signals.conflicts_with,
        validation_status: decision.candidate.validation === 'verified'
          ? 'verified'
          : src.signals.validation_status,
        last_validated_at: src.signals.last_validated_at,
      },
      principal_id: this.options.principalId,
      taint: 'clean',
      metadata: {
        ...src.metadata,
        promoted_from: String(src.id),
        promoted_at: now,
        consensus_count: decision.candidate.consensusCount,
        consensus_atom_ids: decision.candidate.consensusAtoms.map(a => String(a.id)),
      },
    };

    await this.host.atoms.put(promoted);
    await this.host.atoms.update(src.id, { superseded_by: [newId] });
    return newId;
  }

  private async auditRejected(
    decision: PromotionDecision,
    cause: 'policy' | 'human',
  ): Promise<void> {
    const event: AuditEvent = {
      kind: `promotion.rejected.${cause}`,
      principal_id: this.options.principalId,
      timestamp: this.host.clock.now() as Time,
      refs: { atom_ids: [decision.candidate.atom.id] },
      details: {
        target_layer: decision.targetLayer,
        reasons: [...decision.reasons],
        consensus_count: decision.candidate.consensusCount,
        validation: decision.candidate.validation,
      },
    };
    await this.host.auditor.log(event);
  }

  private async auditGated(
    decision: PromotionDecision,
    gate: PromotionOutcome,
  ): Promise<void> {
    const event: AuditEvent = {
      kind: `promotion.gated.${gate.kind}`,
      principal_id: this.options.principalId,
      timestamp: this.host.clock.now() as Time,
      refs: { atom_ids: [decision.candidate.atom.id] },
      details: {
        target_layer: decision.targetLayer,
        reason: gate.reason,
      },
    };
    await this.host.auditor.log(event);
  }

  private async auditPromoted(
    decision: PromotionDecision,
    newAtomId: AtomId,
  ): Promise<void> {
    const event: AuditEvent = {
      kind: 'promotion.applied',
      principal_id: this.options.principalId,
      timestamp: this.host.clock.now() as Time,
      refs: { atom_ids: [decision.candidate.atom.id, newAtomId] },
      details: {
        target_layer: decision.targetLayer,
        consensus_count: decision.candidate.consensusCount,
        validation: decision.candidate.validation,
      },
    };
    await this.host.auditor.log(event);
  }
}

export { DEFAULT_THRESHOLDS, evaluate };
export type {
  PromotableLayer,
  PromotionCandidate,
  PromotionDecision,
  PromotionOutcome,
  PromotionThresholds,
};
