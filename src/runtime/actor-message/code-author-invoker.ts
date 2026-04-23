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
import type { Host } from '../../interface.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
  Time,
} from '../../types.js';
import type { InvokeResult } from './sub-actor-registry.js';
import {
  loadCodeAuthorFence,
  CodeAuthorFenceError,
  type CodeAuthorFence,
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
 * Result shape the injected executor returns when the full chain
 * (draft -> apply branch -> open PR) succeeds. The invoker records
 * the fields on its observation atom and propagates the PR handle
 * through `InvokeResult.dispatched`.
 *
 * The executor is responsible for diff drafting, git ops, and PR
 * creation. Keeping that composition behind an interface lets a
 * consumer swap in a different chain (e.g. an external workflow
 * executor) without modifying the invoker.
 */
export interface CodeAuthorExecutorSuccess {
  readonly kind: 'dispatched';
  readonly prNumber: number;
  readonly prHtmlUrl: string;
  readonly commitSha: string;
  readonly branchName: string;
  readonly totalCostUsd: number;
  readonly modelUsed: string;
  readonly confidence: number;
  readonly touchedPaths: ReadonlyArray<string>;
}

export interface CodeAuthorExecutorFailure {
  readonly kind: 'error';
  readonly stage: string;
  readonly reason: string;
}

export type CodeAuthorExecutorResult =
  | CodeAuthorExecutorSuccess
  | CodeAuthorExecutorFailure;

export interface CodeAuthorExecutor {
  execute(inputs: {
    readonly plan: Atom;
    readonly fence: CodeAuthorFence;
    readonly correlationId: string;
    /**
     * The id the invoker will assign to the observation atom it
     * writes after the executor returns. Passed in so the executor
     * can cite it in durable external artifacts (PR body footer,
     * commit trailer, issue comment) before the atom actually
     * exists. The invoker is responsible for producing this id
     * deterministically and writing the atom under exactly this id
     * after execute() resolves so downstream observers find a
     * concrete atom under the id the PR footer names.
     */
    readonly observationAtomId: AtomId;
    readonly signal?: AbortSignal;
  }): Promise<CodeAuthorExecutorResult>;
}

/**
 * Stable atom-id shape for the code-author-invoked observation.
 * Includes a nonce so repeated invocations of the same plan
 * (manual retry, test fixture seeding the same plan twice) produce
 * distinct atoms. The `at` component is slugged (`:` -> `-`) so the
 * id stays safe as a filename on file-backed Hosts -- NTFS reserves
 * `:` in filenames. Shares this discipline with
 * `mkKillSwitchTrippedAtomId` + the `pr-opened-*` / `execution-failed-*`
 * id construction in integrations/agent-sdk/executor.ts; all three
 * emit filesystem-safe ids while keeping the canonical timestamp on
 * the atom body. Canonical `created_at` on the emitted atom stays
 * full ISO-8601.
 */
export function mkCodeAuthorInvokedAtomId(
  planId: string,
  at: Time,
  nonce: string = randomBytes(3).toString('hex'),
): AtomId {
  // `at` is an ISO-8601 string which embeds `:` in `HH:MM:SS`. Atom ids
  // flow through filesystem paths on file-backed Hosts; Windows NTFS
  // reserves `:` in filenames, so slug colons to `-` while keeping the
  // `created_at` field canonical ISO-8601 elsewhere.
  const atSlug = String(at).replace(/:/g, '-');
  return `code-author-invoked-${planId}-${atSlug}-${nonce}` as AtomId;
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
    /**
     * Optional executor. When provided, the invoker runs the full
     * chain (draft -> branch -> PR) and returns `InvokeResult.dispatched`
     * on success. When undefined, the observation-only path runs and
     * `InvokeResult.completed` is returned.
     *
     * The executor interface isolates the invoker from concrete
     * primitives (drafter, git-ops, pr-creation) so a consumer can
     * plug in a different orchestration (external workflow engine)
     * without touching this module.
     */
    readonly executor?: CodeAuthorExecutor;
    readonly signal?: AbortSignal;
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

  // 3. Pre-compute the observation atom id BEFORE running the
  //    executor. Downstream external artifacts the executor writes
  //    (PR body footer, commit trailer) cite this id so the
  //    post-merge observer can find the corresponding atom with a
  //    direct get(). Previously the executor synthesized a
  //    placeholder id that did not match the final atom id, leaving
  //    PR footers pointing at nonexistent atoms.
  const nowIso = new Date(now()).toISOString() as Time;
  const atomId = mkCodeAuthorInvokedAtomId(String(plan.id), nowIso, options.idNonce);

  // 4. Optional full-chain executor. If one is injected, delegate
  //    the draft -> branch -> PR pipeline to it and record the
  //    outcome on the observation atom. Without an executor the
  //    path stays observation-only.
  //
  //    Follow-up noted (not in this PR): the executor runs before
  //    the atom is persisted, so a crash after PR creation but
  //    before host.atoms.put() leaves an orphan PR. A started-
  //    observation-then-update lifecycle closes this gap but needs
  //    atom-update semantics + crash-recovery tests out of scope
  //    for the wire-up.
  let executorResult: CodeAuthorExecutorResult | undefined;
  if (options.executor !== undefined) {
    try {
      executorResult = await options.executor.execute({
        plan,
        fence,
        correlationId,
        observationAtomId: atomId,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      executorResult = {
        kind: 'error',
        stage: 'executor-threw',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 5. Write the observation. `derived_from: [plan.id]` anchors the
  //    provenance chain; PR handle + stage outcome live on this
  //    atom so a downstream observer can follow the chain in one
  //    read.

  const atom: Atom = {
    schema_version: 1,
    id: atomId,
    content: renderInvokedContent(plan.id, correlationId, fence.warnings, executorResult),
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
      fence_snapshot: {
        max_usd_per_pr: fence.perPrCostCap.max_usd_per_pr,
        required_checks: fence.ciGate.required_checks.slice(),
        on_stop_action: fence.writeRevocationOnStop.on_stop_action,
      },
      ...(executorResult ? { executor_result: renderExecutorMetadata(executorResult) } : {}),
    },
  };

  await host.atoms.put(atom);

  if (executorResult?.kind === 'error') {
    return {
      kind: 'error',
      message: `executor failed at stage=${executorResult.stage}: ${executorResult.reason}`,
    };
  }

  if (executorResult?.kind === 'dispatched') {
    // The PR handle lives on the observation atom's
    // metadata.executor_result; the dispatcher keeps the plan in
    // `executing` and a later observer closes the plan on merge.
    return {
      kind: 'dispatched',
      summary:
        `code-author dispatched plan ${plan.id} as PR #${executorResult.prNumber} `
        + `(${executorResult.commitSha.slice(0, 7)})`,
    };
  }

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
  executorResult?: CodeAuthorExecutorResult,
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
  if (executorResult === undefined) {
    lines.push('This observation records that the code-author principal');
    lines.push('acknowledged an approved plan under a live fence.');
    lines.push('No executor was injected; the plan is marked');
    lines.push('acknowledged-only.');
  } else if (executorResult.kind === 'dispatched') {
    lines.push('Executor completed the full chain:');
    lines.push(`  PR:         #${executorResult.prNumber} ${executorResult.prHtmlUrl}`);
    lines.push(`  Branch:     ${executorResult.branchName}`);
    lines.push(`  Commit:     ${executorResult.commitSha}`);
    lines.push(`  Model:      ${executorResult.modelUsed}`);
    lines.push(`  Confidence: ${executorResult.confidence.toFixed(2)}`);
    lines.push(`  Cost (USD): ${executorResult.totalCostUsd.toFixed(4)}`);
    lines.push(`  Touched paths (${executorResult.touchedPaths.length}):`);
    for (const p of executorResult.touchedPaths) lines.push(`    - ${p}`);
  } else {
    lines.push(`Executor failed at stage "${executorResult.stage}":`);
    lines.push(`  ${executorResult.reason}`);
  }
  return lines.join('\n');
}

function renderExecutorMetadata(
  result: CodeAuthorExecutorResult,
): Record<string, unknown> {
  if (result.kind === 'error') {
    return {
      kind: 'error',
      stage: result.stage,
      reason: result.reason,
    };
  }
  return {
    kind: 'dispatched',
    pr_number: result.prNumber,
    pr_html_url: result.prHtmlUrl,
    branch_name: result.branchName,
    commit_sha: result.commitSha,
    model_used: result.modelUsed,
    confidence: result.confidence,
    total_cost_usd: result.totalCostUsd,
    touched_paths: result.touchedPaths.slice(),
  };
}
