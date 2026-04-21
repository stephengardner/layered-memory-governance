/**
 * Plan execution wrapper (Phase 46).
 *
 * LAG governs PLAN execution; it does not perform execution itself.
 * Callers provide a `run()` callback that does whatever the plan
 * describes (spawn subprocesses, call APIs, edit files, etc). LAG
 * wraps that callback with:
 *
 *   1. Guard: asserts the plan is in state 'approved' before running.
 *   2. Transition: 'approved' -> 'executing' before calling run().
 *   3. Outcome recording: writes each returned outcome as an L0/L1
 *      atom with `provenance.derived_from = [plan.id]` so lineage
 *      from intent to result is preserved.
 *   4. Terminal transition: 'executing' -> 'succeeded' on ok=true,
 *      'executing' -> 'failed' on ok=false. Both are terminal.
 *   5. Audit: state transitions and outcome writes log audit events.
 *
 * This keeps LAG's scope clean: the governance layer owns the
 * trajectory (who approved, what state, what outcomes ensued) while
 * the execution engine is whatever the caller wires up.
 */

import { ConflictError } from '../substrate/errors.js';
import type { Host } from '../substrate/interface.js';
import type {
  Atom,
  AtomId,
  AtomType,
  PrincipalId,
  Scope,
  Time,
} from '../substrate/types.js';
import { transitionPlanState } from './state.js';

export interface ExecutionOutcomeAtom {
  /** Required: the outcome text. */
  readonly content: string;
  /** Default: 'observation'. */
  readonly type?: AtomType;
  /** Default: 0.8. */
  readonly confidence?: number;
  /** Default: inherits plan.scope. */
  readonly scope?: Scope;
}

export interface ExecutePlanOptions {
  /** Principal running the execution wrapper (for audit). */
  readonly principalId: PrincipalId;
  /**
   * User-provided execution callback. Does whatever the plan
   * specifies. Returns ok=true on success with optional outcome
   * atoms; ok=false on failure with optional reason + outcomes.
   */
  readonly run: (plan: Atom) => Promise<ExecutionResult>;
  /**
   * Layer for outcome atoms. Default 'L1' (executor's outcomes are
   * structured observations, not raw input). Use 'L0' if the outcome
   * is raw tool output that needs later extraction.
   */
  readonly outcomeLayer?: 'L0' | 'L1';
  /** Override which principal authored the outcome atoms. Default = principalId. */
  readonly outcomePrincipalId?: PrincipalId;
}

export interface ExecutionResult {
  /** True if the plan executed successfully. */
  readonly ok: boolean;
  /** Reason for failure when ok=false. Included in the terminal transition's reason. */
  readonly reason?: string;
  /** Outcome observations to record as atoms. */
  readonly outcomes?: ReadonlyArray<ExecutionOutcomeAtom>;
}

export interface ExecutionReport {
  readonly planId: AtomId;
  readonly terminalState: 'succeeded' | 'failed';
  readonly outcomesWritten: ReadonlyArray<AtomId>;
  readonly reason: string;
  readonly errors: ReadonlyArray<string>;
}

/**
 * Execute a plan under LAG governance. Safe on failure: a thrown
 * error from `run()` is caught and treated as `ok: false` with the
 * error message as reason, so state transitions still fire
 * correctly and nothing is left in 'executing' indefinitely.
 */
export async function executePlan(
  plan: Atom,
  host: Host,
  options: ExecutePlanOptions,
): Promise<ExecutionReport> {
  if (plan.type !== 'plan') {
    throw new Error(`executePlan: atom ${String(plan.id)} is not a plan (type=${plan.type})`);
  }
  if (plan.plan_state !== 'approved') {
    throw new Error(
      `executePlan: plan ${String(plan.id)} must be in state 'approved', got ${plan.plan_state ?? 'undefined'}`,
    );
  }

  // Transition to executing.
  await transitionPlanState(plan.id, 'executing', host, options.principalId, 'execute-plan: start');

  const outcomeLayer = options.outcomeLayer ?? 'L1';
  const outcomePrincipal = options.outcomePrincipalId ?? options.principalId;
  const errors: string[] = [];
  let ok: boolean;
  let reason: string;
  let outcomes: ReadonlyArray<ExecutionOutcomeAtom>;

  try {
    const result = await options.run(plan);
    ok = result.ok;
    reason = result.reason ?? (ok ? 'ok' : 'run returned ok=false without reason');
    outcomes = result.outcomes ?? [];
  } catch (err) {
    ok = false;
    reason = `run threw: ${err instanceof Error ? err.message : String(err)}`;
    outcomes = [];
  }

  // Write outcome atoms regardless of success (failure outcomes are
  // equally valuable lineage).
  const outcomesWritten: AtomId[] = [];
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i]!;
    const contentHash = host.atoms.contentHash(outcome.content).slice(0, 16);
    const atomId = `outcome-${String(plan.id).slice(0, 12)}-${i}-${contentHash}` as AtomId;
    const now = host.clock.now() as Time;
    const atom: Atom = {
      schema_version: 1,
      id: atomId,
      content: outcome.content,
      type: outcome.type ?? 'observation',
      layer: outcomeLayer,
      provenance: {
        kind: 'agent-observed',
        source: { tool: 'plan-executor' },
        derived_from: [plan.id],
      },
      confidence: outcome.confidence ?? 0.8,
      created_at: now,
      last_reinforced_at: now,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: outcome.scope ?? plan.scope,
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'unchecked',
        last_validated_at: null,
      },
      principal_id: outcomePrincipal,
      taint: 'clean',
      metadata: {
        outcome_of_plan: plan.id,
        outcome_index: i,
        plan_execution_ok: ok,
      },
    };
    try {
      await host.atoms.put(atom);
      outcomesWritten.push(atomId);
    } catch (err) {
      if (err instanceof ConflictError) {
        // Dedup collision with a previous execution; treat as success
        // from our side (atom already exists).
        outcomesWritten.push(atomId);
      } else {
        errors.push(`outcome ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Terminal transition.
  const terminalState: 'succeeded' | 'failed' = ok ? 'succeeded' : 'failed';
  try {
    await transitionPlanState(
      plan.id,
      terminalState,
      host,
      options.principalId,
      `execute-plan: ${reason}`,
    );
  } catch (err) {
    errors.push(
      `terminal transition: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Audit execution-level event (transitions have their own events).
  await host.auditor.log({
    kind: 'plan.executed',
    principal_id: options.principalId,
    timestamp: host.clock.now() as Time,
    refs: { atom_ids: [plan.id, ...outcomesWritten] },
    details: {
      terminal_state: terminalState,
      outcomes_written: outcomesWritten.length,
      reason,
    },
  });

  return {
    planId: plan.id,
    terminalState,
    outcomesWritten,
    reason,
    errors,
  };
}
