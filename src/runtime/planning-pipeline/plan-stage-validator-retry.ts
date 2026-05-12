/**
 * Plan-stage validator-failure retry loop: pure decision + context helpers.
 *
 * Sibling pattern to `auditor-feedback-reprompt.ts`. Where auditor-
 * feedback teaches back AFTER persistence + audit, this module teaches
 * back AFTER schema validation but BEFORE persistence. The pipeline
 * runner already runs `stage.outputSchema?.safeParse(output.value)`
 * before treating the output as valid (see runner.ts header); on
 * failure, today's behaviour is an immediate halt with cause
 * `schema-validation-failed: ${zodError.message}`. That treats the
 * schema-validator as a one-shot gate: a single LLM-emission mistake
 * (a confabulated atom-id, a partial target_paths list, a bare filename)
 * burns the entire pipeline budget and surfaces to the operator as a
 * pipeline-failed atom.
 *
 * This module is the mechanism for a bounded validator-retry loop. When
 * a recoverable schema-validation failure lands and the configured
 * attempt cap has not been reached, the runner re-invokes the same
 * stage with the validator's exact zod error message folded into the
 * next attempt's prompt context. The first failure becomes a teaching
 * moment for the same stage rather than a pipeline halt; the substrate
 * matches the in-session loop where an operator catching a drafter
 * mistake iterates instead of halting (feedback_pipeline_must_match_or_beat_in_session).
 *
 * Substrate purity: this module is pure mechanism. The dial -- WHICH
 * validator error patterns are recoverable + HOW MANY attempts total --
 * is read from a canon policy atom
 * (`pol-plan-stage-validator-retry-default`) by the sibling reader
 * module, NOT hardcoded here. The runner threads the resolved config
 * into `decideValidatorRetryAction`; this function never reads canon.
 * Same posture as `auditor-feedback-reprompt.ts`: mechanism in src/,
 * policy in canon.
 *
 * The decision shape returns `'retry' | 'halt'`. On 'retry' the runner
 * builds an augmented prompt context (via `buildValidatorRetryContext`)
 * and re-invokes the stage's `run()` with that context threaded onto
 * `StageInput.priorValidatorError`. Stage adapters compose the error
 * text into their LLM prompt; this module does not know the prompt
 * shape. Substrate purity again -- the runner is the integration point,
 * the stage is the consumer.
 *
 * Threat-model posture:
 *
 * - Bounded attempts: `max_attempts` is the hard cap (default 2). A
 *   runaway retry loop is impossible by construction; the per-stage
 *   `budget_cap_usd` fence in the runner remains the cost backstop
 *   (cumulative-across-attempts, same as auditor-feedback).
 * - Recoverable-pattern allowlist: retry fires only when the validator
 *   error message contains one of the configured recoverable substrings
 *   (default `['schema-validation-failed']` -- the wholesale category
 *   the runner currently prefixes every zod failure with). A future
 *   non-recoverable error class (e.g. signed-numeric cost prompt-
 *   injection guard, intent-expired-between-attempts) lands outside the
 *   pattern set and halts immediately; the substrate fails closed on
 *   any error message the operator has NOT explicitly authorized for
 *   retry.
 * - Default-deny: when `recoverable_error_patterns` is empty, no retry
 *   ever fires regardless of `max_attempts`. The empty list explicitly
 *   disables the feature without removing the policy atom.
 * - No prompt injection: the runner sanitizes/bounds the validator
 *   error text before passing through; this module assumes the runner
 *   has already bounded the input. `buildValidatorRetryContext` is
 *   purely a formatter.
 */

/**
 * Resolved validator-retry configuration. The runner reads this from
 * canon (`pol-plan-stage-validator-retry-default`) per pipeline run
 * and threads it through every `decideValidatorRetryAction` call. A
 * null canon read falls through to the hardcoded floor (max_attempts=2,
 * recoverable_error_patterns=['schema-validation-failed']) defined in
 * the sibling reader module.
 *
 * The shape is a struct (not bare numbers) so future fields (per-stage
 * overrides, prompt-budget-multiplier, error-path filter) extend the
 * config without breaking call sites. Mirrors the
 * `AuditorFeedbackRePromptConfig` shape so the two retry knobs at the
 * planning-pipeline layer share one mental model.
 */
export interface PlanStageValidatorRetryConfig {
  /**
   * Hard cap on total attempts at a single stage. `max_attempts=2`
   * means: attempt 1 runs once, if the schema-validator rejects then
   * attempt 2 runs ONCE more, then halt regardless. Must be >= 1
   * (max_attempts=0 makes no sense; the runner reads at-least-1
   * stages). Caller validates this; the helper accepts any positive
   * integer and the runner treats `max_attempts <= 1` as "no retry"
   * (the canon-reader fail-closed posture for malformed policy).
   *
   * Operator-tunable via canon edit. An org-ceiling deployment that
   * wants two re-prompts (attempt 1 + attempt 2 + attempt 3) lands a
   * higher-priority `pol-plan-stage-validator-retry-<scope>` atom with
   * `max_attempts: 3`; arbitration resolves the higher-priority atom
   * first.
   */
  readonly max_attempts: number;
  /**
   * Substring patterns matched against the validator's error message.
   * The runner constructs the message as
   * `schema-validation-failed: ${zodError.message}` today; retry fires
   * only when one of the configured patterns is contained in that
   * message. Default `['schema-validation-failed']` (the wholesale
   * category) so every current zod failure is recoverable; an
   * org-ceiling deployment that wants finer control can narrow to
   * specific Zod error-path substrings (e.g.
   * `['target_paths', 'principles_applied']`) so only the well-known
   * LLM-recoverable shapes retry while novel error classes halt
   * immediately for operator inspection.
   *
   * An empty list explicitly disables the retry loop while keeping
   * the policy atom present (mirrors the empty-list disable shape on
   * auditor-feedback). The substring match is plain
   * `String.prototype.includes`; no regex parsing, no normalisation.
   * The runner is the only writer of the error message so the contract
   * surface is stable.
   */
  readonly recoverable_error_patterns: ReadonlyArray<string>;
}

/**
 * Discriminated action result for the runner's validator-failure
 * dispatcher.
 *
 * - `'retry'` -- runner re-invokes the SAME stage with the supplied
 *   `feedbackText` folded into `StageInput.priorValidatorError`. The
 *   text is the formatted prose the stage's prompt template embeds
 *   verbatim.
 * - `'halt'` -- runner takes the existing halt path (failPipeline +
 *   cause `schema-validation-failed: ${zodError.message}`). The runner
 *   constructs the cause from the zod error directly; this module's
 *   job ends at the retry-or-halt decision.
 */
export type ValidatorRetryAction =
  | {
      readonly action: 'retry';
      /** Formatted prose the next attempt's prompt template embeds. */
      readonly feedbackText: string;
    }
  | { readonly action: 'halt' };

/**
 * Per-error-message length cap inside the prompt-augmentation prose.
 * Bounds the prose body so an over-long zod error (a deeply nested
 * structured payload, a runaway refinement message) cannot crowd out
 * the rest of the stage prompt. The runner's per-stage budget_cap_usd
 * is the cost backstop; this bound is the prompt-shape backstop.
 *
 * 4096 chars is generous enough to fit a multi-issue Zod error message
 * (each issue prints its path + message + code) while keeping the
 * appended block well under any reasonable LLM context window. Larger
 * messages are truncated with an explicit marker so the truncation is
 * visible to the LLM (it knows the picture is incomplete).
 */
const MAX_VALIDATOR_ERROR_LEN = 4096;

/**
 * Decide whether the runner should retry the failing stage or take the
 * existing halt path.
 *
 * @param validatorErrorMessage -- the full error message the runner
 *   constructed for the failPipeline call, e.g.
 *   `schema-validation-failed: ${zodError.message}`. Matched against
 *   `config.recoverable_error_patterns` via substring `includes`.
 * @param previousAttempts -- number of attempts ALREADY consumed at
 *   this stage. The runner passes 1 after attempt 1 produces a schema
 *   failure (i.e. attempt 1 is in the books, attempt 2 is the
 *   candidate); `previousAttempts >= max_attempts` halts.
 * @param config -- resolved policy (from canon or hardcoded floor).
 *
 * Decision rules (in order):
 *
 * 1. Empty / missing error message -> halt. Defensive branch: the
 *    runner should always supply the cause, but a misordered caller
 *    cannot silently advance.
 * 2. No recoverable patterns configured (empty allowlist) -> halt.
 *    The empty-list shape is the explicit disable: the operator left
 *    the policy atom present but cleared the trigger list.
 * 3. Error message does not match any configured pattern -> halt.
 *    A novel error class the operator has NOT authorized falls through
 *    to the existing halt path; the substrate fails closed.
 * 4. `previousAttempts >= max_attempts - 1` -> halt. The next attempt
 *    would exceed the cap. Mirrors the same cap check in
 *    decideRePromptAction.
 * 5. Otherwise -> retry with the formatted feedback text.
 *
 * Pure: the function takes structured input and returns a structured
 * decision. No I/O, no atom reads, no thread-of-time. The runner is
 * the integration layer.
 */
export function decideValidatorRetryAction(
  validatorErrorMessage: string,
  previousAttempts: number,
  config: PlanStageValidatorRetryConfig,
): ValidatorRetryAction {
  // Rule 1: empty / missing message collapses to halt. Callers are
  // expected to supply a non-empty cause; this branch keeps the
  // contract loud rather than relying on caller discipline.
  if (typeof validatorErrorMessage !== 'string' || validatorErrorMessage.length === 0) {
    return { action: 'halt' };
  }
  // Rule 2 + 3: pattern allowlist check. An empty patterns list
  // explicitly disables the loop; a non-empty list requires a substring
  // match. Default-deny is the operator-stated posture: a novel error
  // class halts so the operator sees it rather than silently retrying.
  const patterns = config.recoverable_error_patterns;
  if (patterns.length === 0) {
    return { action: 'halt' };
  }
  const matched = patterns.some((p) => validatorErrorMessage.includes(p));
  if (!matched) {
    return { action: 'halt' };
  }
  // Rule 4: attempt cap reached. previousAttempts counts attempts
  // ALREADY consumed; the next attempt would be attempt
  // previousAttempts+1. The cap rejects when previousAttempts+1 >
  // max_attempts, i.e. previousAttempts >= max_attempts.
  //
  // Concrete: max_attempts=2 means attempt 1 + attempt 2 (the retry).
  // After attempt 1 fires, previousAttempts=1; 1 < 2 so retry fires.
  // After attempt 2 fires, previousAttempts=2; 2 >= 2 so halt. The
  // runner gets exactly one retry total per stage at the default
  // floor.
  //
  // Fail-closed on malformed config: a NaN / Infinity / fractional /
  // negative max_attempts is operator-provided data the canon reader
  // already declined to validate (it returns null on malformed atoms,
  // and the caller falls through to the hardcoded floor). But a
  // hand-constructed config -- the test path, a future programmatic
  // caller -- could pass a bad value here. Coerce to a safe integer
  // before the cap check so any non-finite / non-integer / negative
  // value collapses to 0 (immediate halt). Mirrors the same coercion
  // in decideRePromptAction.
  const safeMaxAttempts =
    Number.isFinite(config.max_attempts)
    && Number.isInteger(config.max_attempts)
    && config.max_attempts >= 0
      ? config.max_attempts
      : 0;
  if (previousAttempts >= safeMaxAttempts) {
    return { action: 'halt' };
  }
  // Rule 5: retry. Build the feedback text from the validator error
  // message. Formatting lives in buildValidatorRetryContext so the
  // function is composable independently (a future debugger / replay
  // tool can format a feedback context without hitting the decision
  // path).
  return {
    action: 'retry',
    feedbackText: buildValidatorRetryContext('', validatorErrorMessage),
  };
}

/**
 * Build the prompt-augmentation prose the next attempt's stage runner
 * embeds in its LLM prompt.
 *
 * @param originalPromptContext -- the prior prompt text the stage
 *   adapter would have produced WITHOUT any validator-feedback. Passed
 *   through unchanged at the head of the returned string. Stage
 *   adapters that call this directly can supply '' and concatenate
 *   the formatted error into their own prompt template.
 * @param validatorErrorMessage -- the validator's error message,
 *   typically the runner-constructed
 *   `schema-validation-failed: ${zodError.message}`. Truncated to
 *   MAX_VALIDATOR_ERROR_LEN with an explicit marker when over-long.
 *
 * Format:
 *
 *   <originalPromptContext>
 *
 *   Your prior attempt produced this schema-validation error. Re-emit
 *   the payload so it satisfies the declared schema. Common shapes:
 *   - target_paths partial: every file the body mentions must appear
 *     in target_paths (Form A), OR empty the list (Form B).
 *   - bare filename in target_paths: qualify with directory or use
 *     Form B.
 *   - confidence out of [0,1] / cost_usd negative: re-emit a valid
 *     numeric value.
 *
 *   <validator-error>
 *   <messageBody>
 *   </validator-error>
 *
 * Pure: no I/O, no atom reads. Safe to call from a stage adapter, a
 * test fixture, or a replay tool.
 */
export function buildValidatorRetryContext(
  originalPromptContext: string,
  validatorErrorMessage: string,
): string {
  if (typeof validatorErrorMessage !== 'string' || validatorErrorMessage.length === 0) {
    // No error -> no augmentation. The caller's prompt is returned
    // unchanged. This branch handles a malformed caller that asked for
    // a context with no error; the decision helper short-circuits
    // before reaching this case in practice.
    return originalPromptContext;
  }
  const truncated = validatorErrorMessage.length > MAX_VALIDATOR_ERROR_LEN
    ? `${validatorErrorMessage.slice(0, MAX_VALIDATOR_ERROR_LEN)}... [truncated]`
    : validatorErrorMessage;
  const lines: string[] = [];
  // Leading instruction block. The exact prose mirrors the spec for
  // auditor-feedback so a stage adapter consuming both teaching seams
  // sees one consistent format. Adapters that want a different
  // instruction style can ignore this helper and roll their own
  // formatting using the raw `validatorErrorMessage`.
  lines.push('');
  lines.push('Your prior attempt produced this schema-validation error.');
  lines.push('Re-emit the payload so it satisfies the declared schema.');
  lines.push('Common shapes:');
  lines.push(
    '- target_paths partial: every file the body mentions must appear in '
      + 'target_paths (Form A), OR empty the list (Form B).',
  );
  lines.push(
    '- bare filename in target_paths: qualify with a directory '
      + '(e.g., "apps/console/tests/e2e/<file>") or use Form B.',
  );
  lines.push(
    '- gitignored / build-output path in target_paths: reference the '
      + 'source file the build produces (e.g., src/runtime/foo.ts '
      + 'instead of dist/runtime/foo.js).',
  );
  lines.push(
    '- confidence out of [0,1] / cost_usd negative: re-emit a valid numeric value.',
  );
  lines.push(
    '- empty derived_from / principles_applied entry: every cited atom-id '
      + 'must appear in data.verified_cited_atom_ids.',
  );
  lines.push('');
  lines.push('<validator-error>');
  lines.push(truncated);
  lines.push('</validator-error>');
  return `${originalPromptContext}${lines.join('\n')}`;
}
