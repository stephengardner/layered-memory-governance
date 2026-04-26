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
  /**
   * Verbatim contents of each target file at drafting time. Included
   * in the DATA block so the LLM has accurate ground truth for line
   * numbers + context lines -- critical for APPEND/MODIFY diffs,
   * which git apply --check rejects if the hunk header or context
   * lines disagree with the tree. Callers that can read the repo
   * filesystem populate this before calling; the default executor
   * chain does so from `repoDir` in buildDiffBasedCodeAuthorExecutor.
   *
   * Shape discipline:
   *   - `path` is the repo-relative path the LLM sees in the diff's
   *     `+++ b/<path>` header. Must match an entry in `targetPaths`
   *     when that array is non-empty; otherwise the scope check
   *     rejects the path the LLM echoes back.
   *   - `content` is the exact current file body including line
   *     endings. The LLM expects UTF-8 text; binary files are not
   *     supported in this revision and should be excluded by the
   *     caller before reaching the drafter.
   *   - When a path in `targetPaths` has no corresponding
   *     `fileContents` entry, the LLM treats that path as a
   *     not-yet-existing file (CREATE) and emits `--- /dev/null`
   *     on the old side.
   *   - Empty array or undefined -> key omitted from DATA block so
   *     older registered responses keep matching (MemoryLLM hashes
   *     the full data object).
   */
  readonly fileContents?: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  /**
   * Verbatim prompt of the originating Question atom that the Plan
   * resolves, when available. A Plan's `content` is the Decision's
   * prose answer -- which, through arbitration, can reduce a
   * concrete instruction ("append line X") to a pronoun reference
   * ("the specified line"). Without the original Question body, the
   * LLM cannot reconstruct the literal payload and will emit an
   * empty diff. The drafter includes this field in the DATA block
   * under `question_prompt`; the system prompt tells the LLM to
   * treat it as the source-of-truth payload and to treat the Plan
   * prose as the governance-layer contract around that payload.
   *
   * Empty string or undefined omits the key from DATA so the
   * MemoryLLM data-hash stays compatible with older fixtures.
   */
  readonly questionPrompt?: string;
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
  /**
   * Repository-relative paths the drafter cites in prose (notes,
   * markdown bodies, JSDoc, plan references, comments) as
   * authoritative source. Empty when the drafter declared no
   * citations or pre-dates the schema field. Callers MAY verify
   * each path exists on the working tree before opening a PR; the
   * drafter has no read access to the repo at draft-time and a
   * cited path that does not exist is a confabulation.
   */
  readonly citedPaths: ReadonlyArray<string>;
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
    cited_paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Repository-relative paths cited in prose (notes, markdown bodies, JSDoc, plan '
        + 'references, code comments) as authoritative source. List ONLY paths the diff or '
        + 'its prose explicitly references; do NOT include paths that are merely modified '
        + '(those are derived from the diff headers). The caller MAY verify each entry '
        + 'exists on the working tree before opening a PR; an entry that does not exist '
        + 'is treated as a confabulation and rejected. Omit the field, or emit an empty '
        + 'array, when the prose makes no path citations.',
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
  'File context:',
  '5. The DATA block MAY include a `file_contents` array: `[{ path, content }, ...]`.',
  '   When present, each `content` is the EXACT current body of that file at drafting',
  '   time. Treat it as authoritative ground truth: compute hunk headers (`@@ -N,M +N,M\'+M\'`)',
  '   against those byte-exact contents, and preserve context lines verbatim. A mismatch',
  '   between your hunk context and the supplied `content` causes `git apply --check` to',
  '   reject the diff.',
  '6. When `file_contents` does NOT include a path that is in `target_paths`, treat that',
  '   path as a not-yet-existing file (CREATE). Emit `--- /dev/null` on the old side and',
  '   `+++ b/<path>` on the new side with a `@@ -0,0 +N,M @@` hunk header.',
  '',
  'Payload resolution:',
  '7. The DATA block MAY include a `question_prompt` string: the verbatim originating',
  '   request that the Plan resolves. `plan_content` (the Decision answer) is the',
  '   governance-layer contract and may use abstract references like "the specified',
  '   line"; `question_prompt` is the concrete payload to implement. When both are',
  '   present and conflict, prefer the literal content from `question_prompt` for the',
  '   diff body, and treat `plan_content` as the scope/constraint spec around it.',
  '',
  'You may use Read/Grep/Glob if available to orient further in the codebase. Do not Write,',
  'Edit, Bash, or use any tool outside the read set. Writes route through the PR the caller',
  'creates from your diff; trying to write directly bypasses the fence and is refused.',
  '',
  'Citation discipline:',
  '8. When your prose (notes, or any markdown/JSDoc/comment body inside the diff) cites a',
  '   repository path or file location as authoritative source ("see X at `<path>`",',
  '   "## Source: `<path>`", "implementation lives in `<path>`"), populate `cited_paths`',
  '   with each cited path. Do NOT include paths the diff merely modifies; those are',
  '   derived from the diff headers. Omit the field, or emit an empty array, when prose',
  '   makes no path citations. The caller verifies each entry against the working tree;',
  '   a citation that does not exist is treated as confabulation and rejected. If you are',
  '   unsure a path exists, omit the citation rather than guess.',
].join('\n');

interface JudgeDraftOutput {
  readonly diff: string;
  readonly notes: string;
  readonly confidence: number;
  readonly citedPaths: ReadonlyArray<string>;
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
    // The drafter produces a long schema-bound code diff. `code-author`
    // framing tells adapters that prepend a task-class preamble (e.g.
    // ClaudeCliLLM) to use a code-drafting frame instead of the default
    // "pure JSON classifier" frame. Without this, extended-thinking-
    // enabled models can burn their entire output budget on deliberating
    // about classification semantics and emit zero structured output.
    framingMode: 'code-author',
    // Cap reasoning depth at the substrate's coarse 'high' level.
    // Adapter-level defaults (e.g. an autonomous-flow runner setting
    // a higher provider-specific level) are appropriate for short
    // schema-bound classifications, but on the drafter's long
    // multi-file diff calls an unbounded thinking budget can consume
    // the entire output ceiling before any structured output is
    // emitted. 'high' leaves substantial reasoning room while
    // preserving budget for the diff itself; callers that explicitly
    // need a different level pass `effort` on the per-call options.
    effort: 'high',
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
    citedPaths: Object.freeze(parsed.citedPaths.slice()),
  });
}

function renderPlanForDrafter(inputs: DraftCodeChangeInputs): Record<string, unknown> {
  const data: Record<string, unknown> = {
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
  // Only include `file_contents` when the caller actually supplied
  // content to attach. Adding the key unconditionally (even as an
  // empty array) would shift the data-hash MemoryLLM uses to look up
  // registered responses, breaking every call site that pre-dates
  // this field. "No content to report" -> key absent; that is the
  // same shape older test fixtures hash against.
  if (inputs.fileContents !== undefined && inputs.fileContents.length > 0) {
    data['file_contents'] = inputs.fileContents.map((fc) => ({
      path: fc.path,
      content: fc.content,
    }));
  }
  // Only include `question_prompt` when the caller supplied one.
  // Omitting the key when empty preserves the MemoryLLM data-hash
  // for every fixture that pre-dates this field, same shape
  // discipline as `file_contents` above.
  if (typeof inputs.questionPrompt === 'string' && inputs.questionPrompt.length > 0) {
    data['question_prompt'] = inputs.questionPrompt;
  }
  return data;
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
  // `cited_paths` is optional. Absent = empty list (back-compat with
  // pre-schema-v2 fixtures and adapters that strip optional fields).
  // Present-but-wrong-shape is a schema violation: the fence relies on
  // it being a string array to verify each entry against the working
  // tree without first guarding every element type.
  let citedPaths: ReadonlyArray<string> = [];
  const rawCited = o['cited_paths'];
  if (rawCited !== undefined) {
    if (!Array.isArray(rawCited)) {
      throw new DrafterError(
        `LLM output "cited_paths" must be an array of strings when present; got ${JSON.stringify(rawCited).slice(0, 200)}`,
        'schema-validation-failed',
        costSoFar,
      );
    }
    for (const entry of rawCited) {
      if (typeof entry !== 'string') {
        throw new DrafterError(
          `LLM output "cited_paths" array contains non-string entry: ${JSON.stringify(entry)}`,
          'schema-validation-failed',
          costSoFar,
        );
      }
    }
    citedPaths = rawCited as ReadonlyArray<string>;
  }
  return {
    diff: o['diff'] as string,
    notes: o['notes'] as string,
    confidence: o['confidence'] as number,
    citedPaths,
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
