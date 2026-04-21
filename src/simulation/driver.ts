/**
 * Scenario driver.
 *
 * Runs a Scenario against a MemoryHost. Applies each event in tick order:
 *  - advance the clock to match the tick
 *  - optionally update world ground truth
 *  - optionally have the scripted agent write an atom, with supersessions
 *
 * At checkpoint ticks, performs a search against the host and scores the
 * top-1 hit against the expected label. Also verifies any world-fact
 * assertion piggybacking on the checkpoint.
 *
 * After the last tick, evaluates every SupersessionCheck by reading the
 * affected atoms directly.
 */

import type {
  Atom,
  AtomId,
  AtomSignals,
  PrincipalId,
  Time,
} from '../substrate/types.js';
import type { MemoryHost } from '../adapters/memory/index.js';
import { applyDecision, arbitrate, ValidatorRegistry } from '../arbitration/index.js';
import {
  PromotionEngine,
  type PromotionThresholds,
} from '../promotion/index.js';
import type {
  AgentWrite,
  ArbitrationRecord,
  Checkpoint,
  CheckpointResult,
  PromotionPassOp,
  PromotionRecord,
  RunResult,
  Scenario,
  ScriptedEvent,
  SupersessionCheck,
  SupersessionResult,
} from './types.js';
import { World } from './world.js';

export interface RunOptions {
  readonly validators?: ValidatorRegistry;
  readonly escalationTimeoutMs?: number;
  /** Custom promotion thresholds. Defaults are fine for most scenarios. */
  readonly promotionThresholds?: PromotionThresholds;
  /** Human-gate timeout for L3 promotions. Short for tests. */
  readonly promotionGateTimeoutMs?: number;
}

interface Context {
  readonly host: MemoryHost;
  readonly world: World;
  readonly principalId: PrincipalId;
  readonly labelToAtomId: Map<string, AtomId>;
  readonly atomIdToLabel: Map<AtomId, string>;
  readonly startIso: string;
  readonly validators: ValidatorRegistry | undefined;
  readonly escalationTimeoutMs: number | undefined;
  readonly arbitrations: ArbitrationRecord[];
  readonly promotions: PromotionRecord[];
  readonly promotionEngine: PromotionEngine;
  seq: number;
  lastTick: number;
}

const TICK_MS = 60_000; // one simulated tick = 60 seconds

export async function runScenario(
  scenario: Scenario,
  host: MemoryHost,
  principalId: PrincipalId,
  options: RunOptions = {},
): Promise<RunResult> {
  const world = new World();
  const startIso = host.clock.now();

  const promotionEngine = new PromotionEngine(host, {
    principalId,
    ...(options.validators !== undefined ? { validators: options.validators } : {}),
    ...(options.promotionThresholds !== undefined
      ? { thresholds: options.promotionThresholds }
      : {}),
    ...(options.promotionGateTimeoutMs !== undefined
      ? { humanGateTimeoutMs: options.promotionGateTimeoutMs }
      : {}),
  });

  const ctx: Context = {
    host,
    world,
    principalId,
    labelToAtomId: new Map(),
    atomIdToLabel: new Map(),
    startIso,
    validators: options.validators,
    escalationTimeoutMs: options.escalationTimeoutMs,
    arbitrations: [],
    promotions: [],
    promotionEngine,
    seq: 0,
    lastTick: 0,
  };

  const checkpointResults: CheckpointResult[] = [];

  let atomsWritten = 0;
  let atomsSuperseded = 0;

  // Order events by tick (input may not be strictly sorted).
  const events = [...scenario.events].sort((a, b) => a.tick - b.tick);

  for (const event of events) {
    advanceClockTo(ctx, event.tick);
    applyWorldUpdate(ctx, event);
    if (event.agentWrite) {
      const result = await applyAgentWrite(ctx, event, event.agentWrite);
      atomsWritten += 1;
      atomsSuperseded += result.supersededCount;
    }
    if (event.arbitration) {
      const result = await applyArbitration(ctx, event);
      if (result.supersededOne) atomsSuperseded += 1;
    }
    if (event.promotion) {
      const r = await applyPromotionPass(ctx, event.tick, event.promotion);
      atomsSuperseded += r.superseded;
    }
    // Evaluate any checkpoints scheduled at this tick.
    for (const cp of scenario.checkpoints) {
      if (cp.atTick === event.tick) {
        checkpointResults.push(await evaluateCheckpoint(ctx, cp));
      }
    }
  }

  // Evaluate supersession checks (can reference final state).
  const supersessionResults: SupersessionResult[] = [];
  for (const sc of scenario.supersessionChecks) {
    supersessionResults.push(await evaluateSupersession(ctx, sc));
  }

  return {
    scenarioName: scenario.name,
    ticksProcessed: events.length,
    atomsWritten,
    atomsSuperseded,
    checkpointsPassed: checkpointResults.filter(r => r.passed).length,
    checkpointsTotal: checkpointResults.length,
    checkpointResults,
    supersessionsPassed: supersessionResults.filter(r => r.passed).length,
    supersessionsTotal: supersessionResults.length,
    supersessionResults,
    arbitrations: ctx.arbitrations,
    promotions: ctx.promotions,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function advanceClockTo(ctx: Context, tick: number): void {
  const deltaTicks = tick - ctx.lastTick;
  if (deltaTicks > 0) {
    ctx.host.clock.advance(deltaTicks * TICK_MS);
  }
  ctx.lastTick = tick;
}

function applyWorldUpdate(ctx: Context, event: ScriptedEvent): void {
  if (!event.worldUpdate) return;
  ctx.world.setFact(event.worldUpdate.factId, event.worldUpdate.factValue, event.tick);
}

async function applyAgentWrite(
  ctx: Context,
  event: ScriptedEvent,
  write: AgentWrite,
): Promise<{ supersededCount: number }> {
  ctx.seq += 1;
  const atomId = `sim_${String(ctx.seq).padStart(4, '0')}_${event.label}` as AtomId;
  const now = ctx.host.clock.now();
  const signals: AtomSignals = {
    agrees_with: [],
    conflicts_with: [],
    validation_status: 'unchecked',
    last_validated_at: null,
  };
  const atomPrincipal = (write.principalId ?? ctx.principalId) as PrincipalId;
  const atom: Atom = {
    schema_version: 1,
    id: atomId,
    content: write.content,
    type: write.type,
    layer: 'L1',
    provenance: {
      kind: write.type === 'directive' ? 'user-directive' : 'agent-observed',
      source: { agent_id: write.principalId ?? 'scripted-agent', session_id: 'sim' },
      derived_from: [],
    },
    confidence: write.confidence ?? 0.5,
    created_at: now,
    last_reinforced_at: now,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals,
    principal_id: atomPrincipal,
    taint: 'clean',
    metadata: { scenario_tick: event.tick, scenario_label: event.label },
  };

  await ctx.host.atoms.put(atom);
  ctx.labelToAtomId.set(event.label, atomId);
  ctx.atomIdToLabel.set(atomId, event.label);

  // Apply supersessions: the new atom supersedes each referenced label.
  let supersededCount = 0;
  for (const priorLabel of write.supersedesIds) {
    const priorId = ctx.labelToAtomId.get(priorLabel);
    if (!priorId) {
      throw new Error(
        `applyAgentWrite: supersedesIds references unknown label "${priorLabel}" at tick ${event.tick}`,
      );
    }
    // Update prior atom: add new id to its superseded_by.
    await ctx.host.atoms.update(priorId, { superseded_by: [atomId] });
    // Update new atom: add prior id to its supersedes. Update is idempotent-append.
    await ctx.host.atoms.update(atomId, { supersedes: [priorId] });
    supersededCount += 1;
  }

  return { supersededCount };
}

async function applyArbitration(
  ctx: Context,
  event: ScriptedEvent,
): Promise<{ supersededOne: boolean }> {
  if (!event.arbitration) return { supersededOne: false };
  const newId = ctx.labelToAtomId.get(event.label);
  if (!newId) {
    throw new Error(
      `applyArbitration: no atom for current event label "${event.label}"; arbitration requires an agentWrite in the same event`,
    );
  }
  const priorId = ctx.labelToAtomId.get(event.arbitration.againstLabel);
  if (!priorId) {
    throw new Error(
      `applyArbitration: no atom for againstLabel "${event.arbitration.againstLabel}"`,
    );
  }
  const newAtom = await ctx.host.atoms.get(newId);
  const priorAtom = await ctx.host.atoms.get(priorId);
  if (!newAtom || !priorAtom) {
    throw new Error('applyArbitration: atoms missing from store after put');
  }

  const decision = await arbitrate(newAtom, priorAtom, ctx.host, {
    principalId: ctx.principalId,
    ...(ctx.validators !== undefined ? { validators: ctx.validators } : {}),
    ...(ctx.escalationTimeoutMs !== undefined
      ? { escalationTimeoutMs: ctx.escalationTimeoutMs }
      : {}),
  });
  await applyDecision(decision, ctx.host, ctx.principalId);

  const winnerLabel =
    decision.outcome.kind === 'winner'
      ? ctx.atomIdToLabel.get(decision.outcome.winner) ?? null
      : null;
  const loserLabel =
    decision.outcome.kind === 'winner'
      ? ctx.atomIdToLabel.get(decision.outcome.loser) ?? null
      : null;
  const record: ArbitrationRecord = {
    atTick: event.tick,
    aLabel: event.label,
    bLabel: event.arbitration.againstLabel,
    ruleApplied: decision.ruleApplied,
    outcomeKind: decision.outcome.kind,
    winnerLabel,
    loserLabel,
    reason: decision.outcome.reason,
    detectorKind: decision.pair.kind,
  };
  ctx.arbitrations.push(record);

  return { supersededOne: decision.outcome.kind === 'winner' };
}

async function applyPromotionPass(
  ctx: Context,
  tick: number,
  op: PromotionPassOp,
): Promise<{ superseded: number }> {
  const candidates = await ctx.promotionEngine.findCandidates(op.targetLayer);
  let superseded = 0;
  for (const candidate of candidates) {
    const outcome = await ctx.promotionEngine.promote(candidate, op.targetLayer);
    const sourceLabel = ctx.atomIdToLabel.get(candidate.atom.id) ?? null;
    ctx.promotions.push({
      atTick: tick,
      targetLayer: op.targetLayer,
      outcomeKind: outcome.kind,
      sourceAtomLabel: sourceLabel,
      promotedAtomId: outcome.promotedAtomId ? String(outcome.promotedAtomId) : null,
      reason: outcome.reason,
    });
    if (outcome.kind === 'promoted') superseded += 1;
  }
  return { superseded };
}

async function evaluateCheckpoint(
  ctx: Context,
  cp: Checkpoint,
): Promise<CheckpointResult> {
  const expectedId = ctx.labelToAtomId.get(cp.expectedTopHitLabel) ?? null;
  const hits = await ctx.host.atoms.search(cp.query, 5);
  const top = hits[0] ?? null;
  const topId = top?.atom.id ?? null;
  const topContent = top?.atom.content ?? null;
  const topScore = top?.score ?? null;
  const passed = expectedId !== null && topId === expectedId;

  let worldFactPassed: boolean | null = null;
  let worldFactActual: string | null = null;
  let worldFactExpected: string | null = null;
  if (cp.expectedWorldFact) {
    worldFactExpected = cp.expectedWorldFact.value;
    worldFactActual = ctx.world.oracle(cp.expectedWorldFact.id, cp.atTick);
    worldFactPassed = worldFactActual === worldFactExpected;
  }

  return {
    atTick: cp.atTick,
    query: cp.query,
    passed: passed && (worldFactPassed ?? true),
    expectedLabel: cp.expectedTopHitLabel,
    expectedAtomId: expectedId,
    actualTopHitId: topId,
    actualTopHitContent: topContent,
    actualTopHitScore: topScore,
    worldFactPassed,
    worldFactActual,
    worldFactExpected,
  };
}

async function evaluateSupersession(
  ctx: Context,
  sc: SupersessionCheck,
): Promise<SupersessionResult> {
  const targetId = ctx.labelToAtomId.get(sc.label);
  const supersederId = ctx.labelToAtomId.get(sc.shouldBeSupersededBy);
  if (!targetId) {
    return {
      atTick: sc.atTick,
      label: sc.label,
      shouldBeSupersededBy: sc.shouldBeSupersededBy,
      passed: false,
      reason: `target label "${sc.label}" not found in scenario labels`,
    };
  }
  if (!supersederId) {
    return {
      atTick: sc.atTick,
      label: sc.label,
      shouldBeSupersededBy: sc.shouldBeSupersededBy,
      passed: false,
      reason: `superseder label "${sc.shouldBeSupersededBy}" not found`,
    };
  }
  const atom = await ctx.host.atoms.get(targetId);
  if (!atom) {
    return {
      atTick: sc.atTick,
      label: sc.label,
      shouldBeSupersededBy: sc.shouldBeSupersededBy,
      passed: false,
      reason: `target atom ${String(targetId)} not in store`,
    };
  }
  const passed = atom.superseded_by.includes(supersederId);
  return {
    atTick: sc.atTick,
    label: sc.label,
    shouldBeSupersededBy: sc.shouldBeSupersededBy,
    passed,
    reason: passed
      ? null
      : `superseded_by on ${String(targetId)} = [${atom.superseded_by.join(', ')}], expected to include ${String(supersederId)}`,
  };
}

// ---------------------------------------------------------------------------
// Unused export to keep the Time type lint-quiet; removable later.
// ---------------------------------------------------------------------------

export type { Time };
