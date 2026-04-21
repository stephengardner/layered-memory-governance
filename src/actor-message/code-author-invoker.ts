/**
 * Code-author sub-actor invoker.
 *
 * Registers under the `code-author` principal id with the
 * `SubActorRegistry`. When `runDispatchTick` finds an approved plan
 * whose `metadata.delegation.sub_actor_principal_id` is
 * `code-author`, the registry calls `runCodeAuthor(host, payload,
 * correlationId)` and expects an `InvokeResult`.
 *
 * What this revision does
 * -----------------------
 * Closes the governance loop end-to-end without yet producing a PR:
 *
 *   1. Load + validate the four `pol-code-author-*` fence atoms via
 *      the existing `loadCodeAuthorFence` loader. Refuse to run if
 *      the fence is incomplete, tainted, or superseded.
 *   2. Resolve the plan atom referenced in the payload. Refuse if
 *      absent, not of `type: 'plan'`, or its `plan_state` is not
 *      `executing` (the dispatcher flips approved -> executing
 *      before calling the invoker, so a non-executing plan means a
 *      state-machine bug upstream).
 *   3. Write one `observation` atom (L1) of kind
 *      `code-author-invoked` citing the plan in derived_from. The
 *      observation records the fence state at invocation (warnings
 *      forwarded from the loader) so a later auditor can reconstruct
 *      "what governance posture was live when this invocation ran."
 *
 * The deliberate non-goal: this revision does NOT draft a diff,
 * create a PR, or write code. Those follow-ups plug into the same
 * invoker: apply() replaces the observation-only path with
 * observation + draft-diff + PR creation. The fence load + plan
 * resolution + observation write are the governance skeleton the
 * subsequent changes hang off.
 *
 * Why an observation + returning `completed` with that atom id
 * -----------------------------------------------------------
 * The dispatcher's contract is "sub-actor produced result atoms."
 * A `dispatched` kind is valid for long-running work; returning
 * `completed` with a single observation atom lets the dispatcher
 * flip the plan to `succeeded` and link the result cleanly. Once
 * PR creation lands, the invoker returns `dispatched` with the PR
 * handle and the plan stays `executing` until pr-landing closes it.
 *
 * Fail-closed posture
 * -------------------
 * Every error path returns `{ kind: 'error', message }`:
 *   - fence load failed (missing / tainted / superseded / malformed)
 *   - plan atom not found
 *   - plan is not a plan-type atom
 *   - plan is not in `executing` state
 *
 * The dispatcher handles `error` results by flipping the plan to
 * `failed` and writing the escalation actor-message. This keeps the
 * invoker mechanism-focused: every refusal reason traces back to a
 * canon invariant the dispatcher's existing error path already
 * handles.
 */

import { randomBytes } from 'node:crypto';
import type { Host } from '../interface.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../types.js';
import type { InvokeResult } from './sub-actor-registry.js';
import {
  loadCodeAuthorFence,
  CodeAuthorFenceError,
} from '../actors/code-author/fence.js';

/**
 * Payload shape the code-author invoker consumes. Written on the
 * plan atom's `metadata.delegation.payload` by the planner (or by an
 * operator-authored plan). Minimal in this revision; fields for
 * draft parameters (target paths, success criteria) land when the
 * executor does.
 */
export interface CodeAuthorPayload {
  /**
   * Id of the plan atom being executed. Required. The invoker
   * re-resolves the atom (rather than trusting payload-carried
   * plan content) so a plan that was tainted between approval and
   * dispatch is caught.
   */
  readonly plan_id: AtomId | string;
}

/**
 * Stable atom-id shape for the code-author-invoked observation.
 * Includes a nonce so repeated invocations of the same plan
 * (manual retry, test fixture seeding the same plan twice) produce
 * distinct atoms. Matches the kill-switch-tripped-atom discipline
 * shipped in #72.
 */
export function mkCodeAuthorInvokedAtomId(
  planId: string,
  at: Time,
  nonce: string = randomBytes(3).toString('hex'),
): AtomId {
  return `code-author-invoked-${planId}-${at}-${nonce}` as AtomId;
}

/**
 * Run the code-author invoker against an approved+executing plan.
 * Writes exactly one observation atom on success and returns
 * `InvokeResult.completed` with that atom's id. Returns
 * `InvokeResult.error` on any fail-closed path.
 */
export async function runCodeAuthor(
  host: Host,
  payload: CodeAuthorPayload,
  correlationId: string,
  options: {
    readonly principalId?: PrincipalId;
    readonly now?: () => number;
    readonly idNonce?: string;
  } = {},
): Promise<InvokeResult> {
  const principal = options.principalId ?? ('code-author' as PrincipalId);
  const now = options.now ?? (() => Date.now());

  // 1. Fence load. Refuse to proceed under an incomplete or tainted
  //    fence; the fence atoms ARE the authority grant for this
  //    actor, so missing them is indistinguishable from an
  //    ungoverned write.
  let fence;
  try {
    fence = await loadCodeAuthorFence(host.atoms);
  } catch (err) {
    if (err instanceof CodeAuthorFenceError) {
      return { kind: 'error', message: `fence load failed: ${err.message}` };
    }
    return {
      kind: 'error',
      message: `unexpected fence-load error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Resolve the plan atom. A plan reference that does not
  //    resolve, is the wrong atom type, or is not in the expected
  //    lifecycle state signals an upstream state-machine bug we
  //    must not paper over.
  const planId = String(payload.plan_id) as AtomId;
  const plan = await host.atoms.get(planId);
  if (plan === null) {
    return { kind: 'error', message: `plan atom ${planId} not found in store` };
  }
  if (plan.type !== 'plan') {
    return {
      kind: 'error',
      message: `atom ${planId} has type=${plan.type}, expected "plan"`,
    };
  }
  if (plan.plan_state !== 'executing') {
    return {
      kind: 'error',
      message:
        `plan ${planId} has plan_state=${plan.plan_state}; the dispatcher should `
        + `flip approved -> executing before invoking sub-actors`,
    };
  }

  // 3. Write the observation. `derived_from: [plan.id]` anchors the
  //    provenance chain so the full trace is plan-atom ->
  //    code-author-invoked -> (future) pr-observation atom ->
  //    code-change-delivered atom on merge.
  const nowIso = new Date(now()).toISOString() as Time;
  const atomId = mkCodeAuthorInvokedAtomId(String(plan.id), nowIso, options.idNonce);

  const atom: Atom = {
    schema_version: 1,
    id: atomId,
    content: renderInvokedContent(plan.id, correlationId, fence.warnings),
    type: 'observation',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: {
        agent_id: String(principal),
        tool: 'code-author-invoker',
        session_id: correlationId,
      },
      derived_from: [plan.id],
    },
    confidence: 1.0,
    created_at: nowIso,
    last_reinforced_at: nowIso,
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
    principal_id: principal,
    taint: 'clean',
    metadata: {
      kind: 'code-author-invoked',
      plan_id: String(plan.id),
      correlation_id: correlationId,
      fence_ok: true,
      fence_warnings: fence.warnings.slice(),
      // The fence's operative caps at invocation time; a later
      // auditor reconstructs "what budget was in force for this
      // run" without rejoining against canon at read time.
      fence_snapshot: {
        max_usd_per_pr: fence.perPrCostCap.max_usd_per_pr,
        required_checks: fence.ciGate.required_checks.slice(),
        on_stop_action: fence.writeRevocationOnStop.on_stop_action,
      },
    },
  };

  await host.atoms.put(atom);

  return {
    kind: 'completed',
    producedAtomIds: [String(atomId)],
    summary: `code-author acknowledged plan ${plan.id}; observation ${atomId}`,
  };
}

function renderInvokedContent(
  planId: AtomId,
  correlationId: string,
  fenceWarnings: ReadonlyArray<string>,
): string {
  const lines: string[] = [
    `code-author invoked for plan ${planId}`,
    `correlation_id: ${correlationId}`,
    'fence: loaded, clean, not superseded',
  ];
  if (fenceWarnings.length > 0) {
    lines.push('fence warnings:');
    for (const w of fenceWarnings) lines.push(`  - ${w}`);
  }
  lines.push('');
  lines.push('This observation records that the code-author principal');
  lines.push('acknowledged an approved plan under a live fence.');
  lines.push('PR creation + diff drafting follow in a subsequent');
  lines.push('revision; the plan stays traceable via derived_from on');
  lines.push('downstream atoms.');
  return lines.join('\n');
}
