/**
 * Reference PostCommitValidator: rejects commits whose touched paths
 * are not all declared in the plan's `target_paths` list.
 *
 * Rationale
 * ---------
 * The blast-radius fence the planning pipeline enforces only binds
 * the diff IF the executor honors the plan's declared scope. An
 * agentic agent loop with broader filesystem tools can wander into
 * unrelated files; a runtime drafter retry on a self-correction
 * prompt can shift its edits onto a path nobody approved. This
 * validator catches the resulting "I touched X but the plan said
 * only Y" case at the post-commit boundary so the PR never opens
 * with an unauthorized file.
 *
 * Detection rule:
 *   `touchedPaths.filter(p => !plan.target_paths.includes(p))`
 *   non-empty => critical
 *
 * Comparison is exact-string match against the plan's
 * `target_paths`. Path normalization (POSIX separators, no leading
 * `./`, no trailing slash) is the upstream pipeline's responsibility;
 * a plan that emitted Windows-style paths and a commit touching the
 * POSIX equivalent is a substrate gap, not this validator's problem.
 *
 * Empty-plan policy
 * -----------------
 * When `plan.target_paths` is empty the validator returns critical
 * for any touched path. The substrate's plan-stage already refuses
 * dispatches with empty target_paths upstream (per
 * dev-plan-stage-target-paths-completeness); this validator is the
 * last-line catch when an unusually-shaped plan reached the executor
 * anyway.
 */

import type {
  PostCommitValidator,
  PostCommitValidatorInput,
  PostCommitValidatorResult,
} from '../../../src/substrate/post-commit-validator.js';

export class TargetPathsValidator implements PostCommitValidator {
  readonly name = 'target-paths-validator';

  async validate(input: PostCommitValidatorInput): Promise<PostCommitValidatorResult> {
    const declared = new Set(input.plan.target_paths);
    const undeclared: string[] = [];
    for (const p of input.touchedPaths) {
      if (!declared.has(p)) undeclared.push(p);
    }
    if (undeclared.length === 0) return { ok: true };
    // Sort the undeclared list so the failure reason is deterministic
    // across calls; otherwise audit atoms could diff on ordering
    // alone and produce noisy "same finding, different wording"
    // signals downstream.
    const sortedPreview = undeclared.slice().sort().slice(0, 5);
    const suffix = undeclared.length > 5 ? ` (+${undeclared.length - 5} more)` : '';
    return {
      ok: false,
      severity: 'critical',
      reason: `commit touched paths not declared in plan.target_paths: ${sortedPreview.join(', ')}${suffix}`,
    };
  }
}
