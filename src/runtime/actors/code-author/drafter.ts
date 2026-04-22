/**
 * Code-author diff drafter.
 *
 * Given an approved code-change plan and the live fence, invoke the
 * Host's LLM to produce a unified diff that (a) implements the
 * change the plan describes and (b) touches only paths the plan
 * scopes. Returns the diff string + metadata (cost, model,
 * confidence) or throws on any fail-closed axis.
 *
 * Where this fits in the chain
 * ----------------------------
 * runCodeAuthor invoker -> draftCodeChange (this module) -> git ops
 * -> PR creation via AppBackedGhClient. The drafter sits between
 * "plan resolved, fence loaded" and "filesystem/git/GitHub." It is
 * the only module in the chain that spends LLM budget.
 *
 * Fail-closed posture
 * -------------------
 * The drafter throws `DrafterError` on every refusal path so the
 * invoker can translate to `InvokeResult.error` consistently:
 *
 *   1. LLM call fails / times out / rejects -- cost budget may have
 *      been partially consumed; the observation atom records what
 *      was spent before the failure.
 *   2. LLM output fails schema validation -- diff-shaped response
 *      not received; treat as malformed.
 *   3. Diff fails structural parse (no `---`/`+++` headers) --
 *      the LLM produced prose rather than a diff despite the
 *      schema nudge.
 *   4. Diff touches a path outside the plan's declared target_paths
 *      (when specified) -- the LLM went off-road; reject before any
 *      git operation is attempted.
 *   5. Cost exceeds `pol-code-author-per-pr-cost-cap.max_usd_per_pr`
 *      -- fence atom #2 is enforced at the drafter boundary, before
 *      the PR is created, so a runaway draft never produces a
 *      dispatch result.
 *
 * Cost accounting
 * ---------------
 * Every LLM call's `metadata.cost_usd` is accumulated into a running
 * total. On retry, the retry's cost is ADDED (include_retries=true
 * per fence atom #2). When total > cap, the drafter throws even if
 * the latest call would otherwise have produced a usable diff -- the
 * fence is policy, not advisory.
 */

import type { Host } from '../../../interface.js';
import type { Atom, AtomId, JsonSchema, LlmOptions } from '../../../types.js';
import type { CodeAuthorFence } from './fence.js';

/**
 * Structured request passed to draftCodeChange. The plan atom
 * carries the human-readable description; this struct lifts the
 * tactical fields the drafter needs without re-parsing metadata at
 * the call boundary.
 */
export interface DraftCodeChangeInputs {
  readonly plan: Atom;
  readonly fence: CodeAuthorFence;
  /**
   * Paths the plan scopes as "may be modified." Empty means
   * "the plan's target is captured only in prose" -- the drafter
   * issues a warning but proceeds; path validation then skips.
   * Provenance-grade plans specify this field; a plan from a
   * freeform request may not.
   *
   * Entries MUST be exact file paths (no directories, globs, or
   * patterns). The scope check does strict equality against this
   * set; a directory entry like `src/foo/` would silently reject
   * every touched path as an escape. Callers generating scopes
   * from plan metadata must expand directories/globs to explicit
   * file lists before reaching this boundary.
   */
  readonly targetPaths: ReadonlyArray<string>;
  /** Prose description of "done" from the plan; forwarded to the LLM prompt. */
  readonly successCriteria?: string;
  /** Model id. Framework code stays mechanism-only; caller picks the model. */
  readonly model: string;
  /** Operator-override for the per-pr cost cap. When undefined, fence value is used. */
  readonly maxUsdPerPrOverride?: number;
  /** Forwarded to LlmOptions.disallowedTools (per-principal canon policy). */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** Abort signal; forwarded to LlmOptions.signal so STOP trips propagate. */
  readonly signal?: AbortSignal;
}

export interface DraftResult {
  readonly diff: string;
  readonly notes: string;
  readonly confidence: number;
  /** Total LLM USD spent (sum across retries + this call). */
  readonly totalCostUsd: number;
  readonly modelUsed: string;
  /** Paths the diff touches, parsed from the `+++ b/...` headers. */
  readonly touchedPaths: ReadonlyArray<string>;
}

export class DrafterError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'llm-call-failed'
      | 'schema-validation-failed'
      | 'diff-parse-failed'
      | 'diff-path-escape'
      | 'cost-cap-exceeded',
    public readonly costUsdSoFar: number,
  ) {
    super(message);
    this.name = 'DrafterError';
  }
}

/**
 * JSON schema the LLM must conform to. Returning structured output
 * via `--json-schema` is more reliable than parsing prose; the
 * schema is load-bearing for fail-closed reject-on-malformed.
 */
export const DRAFT_SCHEMA: JsonSchema = Object.freeze({
  type: 'object',
  properties: {
    diff: {
      type: 'string',
      description:
        'Unified diff implementing the change. Must include `---` and `+++` headers for every touched file. '
        + 'Do not include commentary in the diff itself; put commentary in the `notes` field.',
    },
    notes: {
      type: 'string',
      description:
        'Prose commentary on the diff: what was changed, what was left for a follow-up, any constraints '
        + 'the diff could not satisfy. Forwarded verbatim into the PR body.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Subjective confidence the diff applies cleanly and produces the declared behavior. '
        + 'Values below the fence confidence-gate trigger escalation rather than auto-PR.',
    },
  },
  required: ['diff', 'notes', 'confidence'],
  additionalProperties: false,
});

/**
 * System prompt the LLM sees. Mechanism-only: describes the
 * contract (diff shape, path scope) without instance-specific
 * role vocabulary.
 */
export const DRAFT_SYSTEM_PROMPT = [
  'You are producing a unified diff that implements a code change from a plan atom.',
  '',
  'Contract (hard):',
  '1. Output ONE JSON object matching the provided schema. No prose outside the JSON.',
  '2. The `diff` field is a unified diff (`--- a/<path>` + `+++ b/<path>` + hunks). Every',
  '   touched file has both headers. No `diff --git` prefix is required; pure unified',
  '   format is accepted.',
  '3. Modify ONLY the paths listed in the DATA block\'s `target_paths` array, if non-empty.',
  '   A diff touching paths outside that list is rejected downstream; do not produce one.',
  '4. If the plan as described is impossible without modifying a path outside scope,',
  '   explain in `notes`, set `confidence` below 0.5, and emit an empty `diff`.',
  '',
  'You may use Read/Grep/Glob if available to orient in the codebase. Do not Write, Edit,',
  'Bash, or use any tool outside the read set. Writes route through the PR the caller',
  'creates from your diff; trying to write directly bypasses the fence and is refused.',
].join('\n');

interface JudgeDraftOutput {
  readonly diff: string;
  readonly notes: string;
  readonly confidence: number;
}

/**
 * Produce a unified diff for the code-change described by the plan,
 * validated against the fence's cost + path constraints.
 *
 * The implementation is single-shot (no retry loop) in this
 * revision: retries are a policy decision that depends on fence cap
 * + error classification; they land in a follow-up once we see the
 * first real production failure modes.
 */
export async function draftCodeChange(
  host: Host,
  inputs: DraftCodeChangeInputs,
): Promise<DraftResult> {
  // Fence cap is authoritative: an operator-override MAY tighten it
  // (lower the ceiling for a specific run) but MUST NOT loosen it.
  // Accepting `maxUsdPerPrOverride: 1_000_000` would silently bypass
  // pol-code-author-per-pr-cost-cap, which is exactly the fence
  // bypass the atom exists to prevent. Validate the override shape
  // (positive + finite) before using it; mirrors the fence-load
  // invariant that the loader applies to the atom itself.
  const fenceCap = inputs.fence.perPrCostCap.max_usd_per_pr;
  const override = inputs.maxUsdPerPrOverride;
  if (override !== undefined && (!Number.isFinite(override) || override <= 0)) {
    throw new DrafterError(
      `maxUsdPerPrOverride must be a positive finite number; got ${JSON.stringify(override)}`,
      'cost-cap-exceeded',
      0,
    );
  }
  const costCap = override !== undefined ? Math.min(override, fenceCap) : fenceCap;
  let costUsdSoFar = 0;

  const llmOptions: LlmOptions = {
    model: inputs.model,
    temperature: 0.2,
    max_budget_usd: costCap,
    sandboxed: true,
    ...(inputs.signal ? { signal: inputs.signal } : {}),
    ...(inputs.disallowedTools ? { disallowedTools: inputs.disallowedTools } : {}),
  };

  const data = renderPlanForDrafter(inputs);

  let rawOutput: unknown;
  let modelUsed = inputs.model;
  try {
    const result = await host.llm.judge(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, llmOptions);
    rawOutput = result.output;
    modelUsed = result.metadata.model_used;
    // Fail closed on invalid cost shape. A NaN / Infinity / negative-
    // other-than-sentinel value from a broken or compromised adapter
    // would silently under-count spend, letting a runaway call bypass
    // the per-PR cap. Adapter convention: `cost_usd: -1` is "unreported"
    // (honored by MemoryLLM + any adapter the contract names); it
    // contributes zero to the accumulator rather than failing the call.
    // Any OTHER invalid shape is rejected.
    const callCostUsd = result.metadata.cost_usd;
    if (callCostUsd === -1) {
      // Adapter did not report; treat as zero contribution. The
      // cap enforcement still runs downstream; a succession of
      // -1 reports cannot breach the cap but also cannot be
      // audited for spend. That is an adapter-choice property
      // documented in the LLM interface.
    } else if (!Number.isFinite(callCostUsd) || callCostUsd < 0) {
      throw new DrafterError(
        `LLM metadata.cost_usd must be a non-negative finite number (or -1 for unreported); got ${String(callCostUsd)}`,
        'cost-cap-exceeded',
        costUsdSoFar,
      );
    } else {
      costUsdSoFar += callCostUsd;
    }
  } catch (err) {
    // Don't re-wrap our own DrafterError (the cost-shape guard
    // above throws one); propagate it verbatim so the caller sees
    // the precise reason.
    if (err instanceof DrafterError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new DrafterError(
      `LLM draft call failed: ${reason}`,
      'llm-call-failed',
      costUsdSoFar,
    );
  }

  // Enforce the cost cap at the drafter boundary -- fence atom #2
  // is authoritative over the adapter's own max_budget_usd because
  // the fence includes retries and adapter-level caps are per-call.
  if (costUsdSoFar > costCap) {
    throw new DrafterError(
      `LLM spend ${costUsdSoFar.toFixed(4)} USD exceeds fence cap ${costCap.toFixed(4)} USD`,
      'cost-cap-exceeded',
      costUsdSoFar,
    );
  }

  const parsed = validateDraftOutput(rawOutput, costUsdSoFar);

  // A non-empty "diff" string that lacks `--- `/`+++ ` headers is
  // the LLM producing prose in the diff slot. Catch it here so the
  // downstream path-scope check (which silently treats empty
  // touched-paths as "no change") does not let a malformed diff
  // slip through to git ops.
  if (parsed.diff.trim().length > 0 && !looksLikeUnifiedDiff(parsed.diff)) {
    throw new DrafterError(
      'LLM "diff" field is non-empty but lacks unified-diff headers',
      'diff-parse-failed',
      costUsdSoFar,
    );
  }

  const touched = parseTouchedPaths(parsed.diff);
  validatePathScope(touched, inputs.targetPaths, costUsdSoFar);

  return Object.freeze({
    diff: parsed.diff,
    notes: parsed.notes,
    confidence: parsed.confidence,
    totalCostUsd: costUsdSoFar,
    modelUsed,
    touchedPaths: Object.freeze(touched.slice()),
  });
}

function renderPlanForDrafter(inputs: DraftCodeChangeInputs): Record<string, unknown> {
  return {
    plan_id: String(inputs.plan.id),
    plan_title:
      typeof inputs.plan.metadata['title'] === 'string'
        ? (inputs.plan.metadata['title'] as string)
        : '(untitled)',
    plan_content: inputs.plan.content,
    target_paths: inputs.targetPaths.slice(),
    success_criteria: inputs.successCriteria ?? '',
    fence_snapshot: {
      max_usd_per_pr: inputs.fence.perPrCostCap.max_usd_per_pr,
      required_checks: inputs.fence.ciGate.required_checks.slice(),
    },
  };
}

function validateDraftOutput(raw: unknown, costSoFar: number): JudgeDraftOutput {
  if (!raw || typeof raw !== 'object') {
    throw new DrafterError(
      `LLM output is not an object: ${JSON.stringify(raw).slice(0, 200)}`,
      'schema-validation-failed',
      costSoFar,
    );
  }
  const o = raw as Record<string, unknown>;
  if (typeof o['diff'] !== 'string') {
    throw new DrafterError(
      `LLM output missing string field "diff"; got ${JSON.stringify(o['diff'])}`,
      'schema-validation-failed',
      costSoFar,
    );
  }
  if (typeof o['notes'] !== 'string') {
    throw new DrafterError(
      `LLM output missing string field "notes"; got ${JSON.stringify(o['notes'])}`,
      'schema-validation-failed',
      costSoFar,
    );
  }
  if (
    typeof o['confidence'] !== 'number'
    || !Number.isFinite(o['confidence'])
    || (o['confidence'] as number) < 0
    || (o['confidence'] as number) > 1
  ) {
    throw new DrafterError(
      `LLM output "confidence" must be a number in [0,1]; got ${JSON.stringify(o['confidence'])}`,
      'schema-validation-failed',
      costSoFar,
    );
  }
  return {
    diff: o['diff'] as string,
    notes: o['notes'] as string,
    confidence: o['confidence'] as number,
  };
}

/**
 * Extract the set of paths the diff modifies from `+++ b/<path>`
 * lines. A well-formed unified diff has one such line per file;
 * `/dev/null` appears when a file is deleted (the matching `+++`
 * points at the real path when creating, or at `/dev/null` when
 * deleting). We collect both new-side and old-side paths for scope
 * validation so a create or delete stays in scope.
 */
function parseTouchedPaths(diff: string): string[] {
  const paths = new Set<string>();
  const minusRe = /^--- (?:a\/)?([^\s\r\n]+)/gm;
  const plusRe = /^\+\+\+ (?:b\/)?([^\s\r\n]+)/gm;
  // The capture group is non-optional; the match always yields a
  // string at index 1 when successful. The only real filter is
  // /dev/null (which appears on one side of a create/delete diff
  // and is not an actual path in the tree).
  let m: RegExpExecArray | null;
  while ((m = minusRe.exec(diff)) !== null) {
    if (m[1] !== '/dev/null') paths.add(m[1]!);
  }
  while ((m = plusRe.exec(diff)) !== null) {
    if (m[1] !== '/dev/null') paths.add(m[1]!);
  }
  return Array.from(paths);
}

function validatePathScope(
  touched: ReadonlyArray<string>,
  targetPaths: ReadonlyArray<string>,
  costSoFar: number,
): void {
  // An empty diff (no paths touched) is not a scope violation by
  // itself -- callers interpret that as "no change produced" and
  // can decide whether to retry. Only flag escape when the diff
  // DID touch paths and any are outside scope.
  if (touched.length === 0) return;
  if (targetPaths.length === 0) return; // scope not declared; skip
  const allowed = new Set(targetPaths);
  const outside = touched.filter((p) => !allowed.has(p));
  if (outside.length > 0) {
    throw new DrafterError(
      `diff touches paths outside plan scope: ${outside.join(', ')} (allowed: ${targetPaths.join(', ')})`,
      'diff-path-escape',
      costSoFar,
    );
  }
}

/**
 * Structural diff parse check. Returns true iff the string contains
 * at least one `---` header followed later by a matching `+++`
 * header. Callers that want a strict parse can use this as a
 * pre-flight; the drafter's `validateDraftOutput` + `parseTouchedPaths`
 * surface the same information through the structured-error path.
 */
export function looksLikeUnifiedDiff(s: string): boolean {
  // Unified diff order is `--- a/<path>` then `+++ b/<path>` on the
  // next line. A string where `+++` appears before `---` is
  // structurally malformed; rejecting it prevents a reversed-header
  // diff from reaching patch application downstream.
  return /^--- [^\r\n]+(?:\r?\n)\+\+\+ [^\r\n]+/m.test(s);
}

export { type AtomId };
