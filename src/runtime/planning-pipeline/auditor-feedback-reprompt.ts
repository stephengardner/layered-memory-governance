/**
 * Auditor-feedback re-prompt loop: pure decision + context helpers.
 *
 * Today the pipeline runner halts on the first critical audit finding.
 * That treats the auditor as a one-shot gate: the failing stage gets no
 * second chance, the operator has to inspect and reseed manually. This
 * module is the mechanism for a bounded re-prompt loop. When a critical
 * finding lands and the configured attempt cap has not been reached, the
 * runner re-invokes the same stage with the auditor's findings folded
 * into the next attempt's prompt context. The first finding becomes a
 * teaching moment for the same stage rather than a pipeline halt.
 *
 * Substrate purity: this module is pure mechanism. The dial -- WHICH
 * severities trigger a re-prompt + HOW MANY attempts total -- is read
 * from a canon policy atom (pol-auditor-feedback-reprompt-default) by
 * the sibling reader module, NOT hardcoded here. The runner threads the
 * resolved config into `decideRePromptAction`; this function never reads
 * canon. Same posture as `loop-pass-claim-reaper.ts`: mechanism in src/,
 * policy in canon.
 *
 * The decision shape returns `'reprompt' | 'halt'`. On 'reprompt' the
 * runner builds an augmented prompt context (via `buildRePromptContext`)
 * and re-invokes the stage's `run()` with that context threaded onto
 * `StageInput.priorAuditFindings`. Stage adapters compose the findings
 * text into their LLM prompt; this module does not know the prompt
 * shape. Substrate purity again -- the runner is the integration point,
 * the stage is the consumer.
 *
 * Threat-model posture:
 *
 * - Bounded attempts: `max_attempts` is the hard cap (default 2). A
 *   runaway re-prompt loop is impossible by construction; the per-stage
 *   `budget_cap_usd` fence in the runner remains the cost backstop.
 * - Severity floor: re-prompt fires only on configured severities
 *   (default ['critical']). A 'minor' finding never widens the surface
 *   even if max_attempts > 0; the auditor stays the gate, the loop is
 *   the teaching seam.
 * - Default-deny: when `severities_to_reprompt` is empty, no re-prompt
 *   ever fires regardless of `max_attempts`. The empty list explicitly
 *   disables the feature without removing the policy atom.
 * - No prompt injection: the runner sanitizes/bounds the finding text
 *   before passing through; this module assumes the runner has already
 *   bounded the input. `buildRePromptContext` is purely a formatter.
 */

import type { AuditFinding } from './types.js';

/**
 * Resolved auditor-feedback re-prompt configuration. The runner reads
 * this from canon (pol-auditor-feedback-reprompt-default) per pipeline
 * run and threads it through every `decideRePromptAction` call. A null
 * canon read falls through to the hardcoded floor (max_attempts=2,
 * severities=['critical']) defined in the sibling reader module.
 *
 * The shape is a struct (not bare numbers) so future fields (per-stage
 * overrides, prompt-budget-multiplier, cite-only-list) extend the
 * config without breaking call sites. Mirrors the
 * `LoopPassClaimReaperPolicy` shape from `loop-pass-claim-reaper.ts`.
 */
export interface AuditorFeedbackRePromptConfig {
  /**
   * Hard cap on total attempts at a single stage. `max_attempts=2`
   * means: attempt 1 runs once, if findings trigger re-prompt then
   * attempt 2 runs ONCE more, then halt regardless. Must be >= 1
   * (max_attempts=0 makes no sense; the runner reads at-least-1
   * stages). Caller validates this; the helper accepts any positive
   * integer and the runner treats `max_attempts <= 1` as "no re-prompt"
   * (the canon-reader fail-closed posture for malformed policy).
   */
  readonly max_attempts: number;
  /**
   * Which audit-finding severities trigger a re-prompt. An empty list
   * disables the re-prompt loop entirely while keeping the policy atom
   * present (so the operator sees the explicit disable rather than
   * "policy missing"). Default ['critical'] per the brief: a critical
   * finding is the only severity where the auditor proved the output
   * unsafe; major and minor are advisory. Org-ceiling deployments may
   * widen to ['critical', 'major'] via canon edit.
   */
  readonly severities_to_reprompt: ReadonlyArray<AuditFinding['severity']>;
}

/**
 * Discriminated action result for the runner's audit-block dispatcher.
 *
 * - `'reprompt'` -- runner re-invokes the SAME stage with the supplied
 *   `feedbackText` folded into `StageInput.priorAuditFindings` (or a
 *   parallel prompt-augmentation field; this module does not encode
 *   the exact mechanism). `feedbackText` is the formatted prose the
 *   stage's prompt template embeds verbatim.
 * - `'halt'` -- runner takes the existing halt path (failPipeline +
 *   `cause: 'critical-audit-finding'` when any actionable finding is
 *   critical, or accept-with-warning when the configured severities do
 *   not include the observed severity). The runner reads the findings
 *   directly to pick the right cause; this module's job ends at the
 *   re-prompt-or-halt decision.
 */
export type RePromptAction =
  | {
      readonly action: 'reprompt';
      /** Formatted prose the next attempt's prompt template embeds. */
      readonly feedbackText: string;
    }
  | { readonly action: 'halt' };

/**
 * Per-finding line length cap inside the prompt-augmentation prose.
 * Mirrors `MAX_FINDING_MESSAGE_LEN` from the spec (section 6, prompt-
 * injection mitigation): bound the auditor's free-form text so an
 * over-long finding cannot crowd out the rest of the stage prompt.
 *
 * 1024 chars * up to MAX_FINDINGS_FORMATTED findings = ~16KB ceiling
 * on the appended block. The stage's budget_cap_usd is the cost
 * backstop; this bound is the prompt-shape backstop.
 */
const MAX_FINDING_MESSAGE_LEN = 1024;

/**
 * Cap on number of findings formatted into a single re-prompt context.
 * A stage that emits 100+ findings is a malformed adapter; the runner
 * already caps the per-stage finding-write at MAX_CITED_LIST (256), so
 * this cap is the prompt-side trim. Keep this less-than-or-equal to
 * the runner's per-stage cap so the prompt never truncates inside the
 * runner's emit bound.
 */
const MAX_FINDINGS_FORMATTED = 32;

/**
 * Decide whether the runner should re-prompt the failing stage or take
 * the existing halt path.
 *
 * @param findings -- audit findings produced by the just-completed
 *   stage attempt. The runner has already persisted these as
 *   `pipeline-audit-finding` atoms; this function reads severity only.
 * @param previousAttempts -- number of attempts ALREADY consumed at
 *   this stage. The runner passes 1 after attempt 1 produces findings
 *   (i.e. attempt 1 is in the books, attempt 2 is the candidate);
 *   `previousAttempts >= max_attempts` halts.
 * @param config -- resolved policy (from canon or hardcoded floor).
 *
 * Decision rules (in order):
 *
 * 1. No findings -> halt (`action: 'halt'`). The caller is expected to
 *    branch on this earlier (no findings = stage passed), but the
 *    function is defined for safety so a misordered caller cannot
 *    silently advance.
 * 2. No actionable findings (none in `severities_to_reprompt`) -> halt.
 *    The runner uses the existing halt-on-critical / accept-on-non-
 *    critical logic; this module signals "do not re-prompt".
 * 3. `previousAttempts >= max_attempts - 1` -> halt. The next attempt
 *    would exceed the cap. The runner returns the existing
 *    halt-on-critical result with the original critical-finding cause.
 * 4. Otherwise -> reprompt with the formatted feedback text.
 *
 * Pure: the function takes structured input and returns a structured
 * decision. No I/O, no atom reads, no thread-of-time. The runner is
 * the integration layer.
 */
export function decideRePromptAction(
  findings: ReadonlyArray<AuditFinding>,
  previousAttempts: number,
  config: AuditorFeedbackRePromptConfig,
): RePromptAction {
  // Rule 1: empty findings list collapses to halt. Caller is expected
  // to short-circuit before reaching here (no findings = stage passed
  // its audit), but the explicit branch keeps the contract loud rather
  // than relying on caller discipline.
  if (findings.length === 0) {
    return { action: 'halt' };
  }
  // Rule 2: no actionable findings (severities_to_reprompt is empty
  // OR none of the findings match the configured severities). The
  // empty-allowlist case is the explicit disable: the operator left
  // the policy atom present but cleared the trigger list. The mixed
  // case (e.g. config = ['critical'], findings = all 'minor') falls
  // through here because the auditor surfaced advisory issues only --
  // the runner's existing accept-on-non-critical path handles those.
  const actionable = findings.filter((f) => config.severities_to_reprompt.includes(f.severity));
  if (actionable.length === 0) {
    return { action: 'halt' };
  }
  // Rule 3: attempt cap reached. previousAttempts counts attempts
  // ALREADY consumed; the next attempt would be attempt
  // previousAttempts+1. The cap rejects when previousAttempts+1 >
  // max_attempts, i.e. previousAttempts >= max_attempts.
  //
  // Concrete: max_attempts=2 means attempt 1 + attempt 2 (the
  // re-prompt). After attempt 1 fires, previousAttempts=1; 1 < 2 so
  // re-prompt fires. After attempt 2 fires, previousAttempts=2; 2 >= 2
  // so halt. The runner gets exactly one re-prompt total per stage.
  if (previousAttempts >= config.max_attempts) {
    return { action: 'halt' };
  }
  // Rule 4: re-prompt. Build the feedback text from the actionable
  // findings only -- below-floor findings are not part of the teaching
  // signal because the auditor accepted them. Formatting lives in
  // buildRePromptContext so the function is composable independently
  // (a future debugger / replay tool can format a finding list without
  // hitting the decision path).
  return {
    action: 'reprompt',
    feedbackText: buildRePromptContext('', actionable),
  };
}

/**
 * Build the prompt-augmentation prose the next attempt's stage runner
 * embeds in its LLM prompt.
 *
 * @param originalPromptContext -- the prior prompt text the stage
 *   adapter would have produced WITHOUT any audit-feedback. Passed
 *   through unchanged at the head of the returned string. Stage
 *   adapters that call this directly can supply '' and concatenate
 *   the formatted findings into their own prompt template.
 * @param auditorFindings -- the actionable findings to embed. Each
 *   finding renders as a bullet with severity + category + message,
 *   plus its cited paths and atom-ids if present.
 *
 * Format (mirrors the spec section 5 prompt template):
 *
 *   <originalPromptContext>
 *
 *   Your prior attempt produced these audit findings. Re-emit the
 *   payload addressing each finding before returning. If a finding
 *   flags a fabricated citation, omit the citation. If a finding flags
 *   an out-of-set citation, omit it or replace it with a verified id
 *   from the verified_cited_atom_ids set.
 *
 *   - [<severity>] <category>: <message>
 *     cited_paths: <paths joined>
 *     cited_atom_ids: <ids joined>
 *
 * Findings are capped at `MAX_FINDINGS_FORMATTED` (the head of the
 * list). Each finding's message is truncated to
 * `MAX_FINDING_MESSAGE_LEN` chars to bound the appended block. The
 * runner's existing per-stage budget_cap_usd remains the cost
 * backstop; this trim is the prompt-shape backstop so a 100-finding
 * stage cannot crowd out its own prompt.
 *
 * Pure: no I/O, no atom reads. Safe to call from a stage adapter, a
 * test fixture, or a replay tool.
 */
export function buildRePromptContext(
  originalPromptContext: string,
  auditorFindings: ReadonlyArray<AuditFinding>,
): string {
  if (auditorFindings.length === 0) {
    // No findings -> no augmentation. The caller's prompt is returned
    // unchanged. This branch handles a malformed caller that asked for
    // a context with no findings; the decision helper short-circuits
    // before reaching this case in practice.
    return originalPromptContext;
  }
  const bounded = auditorFindings.slice(0, MAX_FINDINGS_FORMATTED);
  const lines: string[] = [];
  // Leading instruction block. The exact prose mirrors the spec
  // (section 5) so a brainstorm-stage migrating to the loop sees the
  // same teaching seam the spec promised. Adapters that want a
  // different instruction style can ignore this helper and roll their
  // own formatting using the same `auditorFindings` array.
  lines.push('');
  lines.push('Your prior attempt produced these audit findings.');
  lines.push('Re-emit the payload addressing each finding before returning.');
  lines.push('If a finding flags a fabricated citation, omit the citation.');
  lines.push('If a finding flags an out-of-set citation, omit it or replace');
  lines.push('it with a verified id from the verified_cited_atom_ids set.');
  lines.push('');
  for (const finding of bounded) {
    const message = finding.message.length > MAX_FINDING_MESSAGE_LEN
      ? `${finding.message.slice(0, MAX_FINDING_MESSAGE_LEN)}... [truncated]`
      : finding.message;
    lines.push(`- [${finding.severity}] ${finding.category}: ${message}`);
    if (finding.cited_paths.length > 0) {
      lines.push(`  cited_paths: ${finding.cited_paths.join(', ')}`);
    }
    if (finding.cited_atom_ids.length > 0) {
      lines.push(`  cited_atom_ids: ${finding.cited_atom_ids.join(', ')}`);
    }
  }
  if (auditorFindings.length > MAX_FINDINGS_FORMATTED) {
    // Surface the trim so the LLM sees that not every finding was
    // displayed. Stage adapters that need the full list inspect the
    // pipeline-audit-finding atoms by metadata.pipeline_id; the prompt
    // is the teaching seam, not the audit trail.
    lines.push('');
    lines.push(
      `(${auditorFindings.length - MAX_FINDINGS_FORMATTED} more findings omitted; `
        + 'inspect pipeline-audit-finding atoms for the full list.)',
    );
  }
  return `${originalPromptContext}${lines.join('\n')}`;
}
