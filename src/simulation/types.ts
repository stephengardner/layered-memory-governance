/**
 * Simulation types.
 *
 * A Scenario scripts a sequence of ScriptedEvent ticks, Checkpoint queries,
 * and SupersessionCheck assertions. The driver runs it against a Host and
 * reports pass/fail with enough detail to debug.
 *
 * Atom ids are generated internally; scripts reference them by opaque
 * `label` strings that are resolved by the driver as events execute.
 */

import type {
  Atom,
  AtomId,
  AtomType,
} from '../substrate/types.js';

export interface WorldUpdate {
  readonly factId: string;
  readonly factValue: string;
}

export interface AgentWrite {
  readonly content: string;
  readonly type: AtomType;
  readonly confidence?: number;
  /** Labels of earlier events whose atoms this new atom supersedes. */
  readonly supersedesIds: ReadonlyArray<string>;
  /**
   * Override the principal_id written on this atom. Default: the driver's
   * scenario-level principal. Use this for scenarios that need multiple
   * distinct principals to establish consensus (scenario 3, promotions).
   */
  readonly principalId?: string;
}

export interface ArbitrationOp {
  /** Label of an earlier event whose atom to arbitrate against this tick's. */
  readonly againstLabel: string;
  /** Principal under which arbitration runs. Defaults to driver's principal. */
  readonly principalId?: string;
}

export interface PromotionPassOp {
  /** Target layer for the promotion pass: L2 (from L1) or L3 (from L2). */
  readonly targetLayer: 'L2' | 'L3';
}

export interface ScriptedEvent {
  readonly tick: number;
  /** Unique label; later events can reference this via supersedesIds. */
  readonly label: string;
  /** Effect on simulated world ground truth, if any. */
  readonly worldUpdate: WorldUpdate | null;
  /** What the agent writes to the palace at this tick, if anything. */
  readonly agentWrite: AgentWrite | null;
  /**
   * If set, after the agentWrite lands the driver runs arbitrate() between
   * the new atom and the atom bound to `againstLabel`, then applyDecision.
   * Omit or set to null for scenarios that do not exercise auto-arbitration.
   */
  readonly arbitration?: ArbitrationOp | null;
  /**
   * If set, the driver runs the promotion engine at the given target layer
   * AFTER any agentWrite and arbitration on this tick. Useful for scripting
   * consensus-reaches-threshold moments. The engine runs a full pass
   * (findCandidates + promote) across all eligible atoms, not just this
   * tick's own. Omit for scenarios that do not exercise promotion.
   */
  readonly promotion?: PromotionPassOp | null;
}

export interface Checkpoint {
  readonly atTick: number;
  readonly query: string;
  /** Label of the atom that should be the top-1 search hit. */
  readonly expectedTopHitLabel: string;
  /** Optional world-state assertion for the same tick. */
  readonly expectedWorldFact?: { readonly id: string; readonly value: string };
}

export interface SupersessionCheck {
  readonly atTick: number;
  /** Label of the atom that should now be marked superseded. */
  readonly label: string;
  /** Label of the atom that should appear in the target's superseded_by list. */
  readonly shouldBeSupersededBy: string;
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly events: ReadonlyArray<ScriptedEvent>;
  readonly checkpoints: ReadonlyArray<Checkpoint>;
  readonly supersessionChecks: ReadonlyArray<SupersessionCheck>;
}

// ---------------------------------------------------------------------------
// Run-time results
// ---------------------------------------------------------------------------

export interface CheckpointResult {
  readonly atTick: number;
  readonly query: string;
  readonly passed: boolean;
  readonly expectedLabel: string;
  readonly expectedAtomId: AtomId | null;
  readonly actualTopHitId: AtomId | null;
  readonly actualTopHitContent: string | null;
  readonly actualTopHitScore: number | null;
  readonly worldFactPassed: boolean | null;
  readonly worldFactActual: string | null;
  readonly worldFactExpected: string | null;
}

export interface SupersessionResult {
  readonly atTick: number;
  readonly label: string;
  readonly shouldBeSupersededBy: string;
  readonly passed: boolean;
  readonly reason: string | null;
}

export interface ArbitrationRecord {
  readonly atTick: number;
  readonly aLabel: string;
  readonly bLabel: string;
  readonly ruleApplied: string;
  readonly outcomeKind: 'winner' | 'coexist' | 'escalate';
  readonly winnerLabel: string | null;
  readonly loserLabel: string | null;
  readonly reason: string;
  readonly detectorKind: string;
}

export interface PromotionRecord {
  readonly atTick: number;
  readonly targetLayer: 'L2' | 'L3';
  readonly outcomeKind: 'promoted' | 'rejected-by-policy' | 'rejected-by-human' | 'timed-out-awaiting-human';
  readonly sourceAtomLabel: string | null;
  readonly promotedAtomId: string | null;
  readonly reason: string;
}

export interface RunResult {
  readonly scenarioName: string;
  readonly ticksProcessed: number;
  readonly atomsWritten: number;
  readonly atomsSuperseded: number;
  readonly checkpointsPassed: number;
  readonly checkpointsTotal: number;
  readonly checkpointResults: ReadonlyArray<CheckpointResult>;
  readonly supersessionsPassed: number;
  readonly supersessionsTotal: number;
  readonly supersessionResults: ReadonlyArray<SupersessionResult>;
  readonly arbitrations: ReadonlyArray<ArbitrationRecord>;
  readonly promotions: ReadonlyArray<PromotionRecord>;
}

// Handy type re-export to keep scenario authors from importing Atom directly.
export type { Atom, AtomId, AtomType };
