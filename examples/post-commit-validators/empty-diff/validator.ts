/**
 * Reference PostCommitValidator: rejects empty / no-op commits.
 *
 * Rationale
 * ---------
 * The drafter (and an agentic agent loop) can report success with an
 * empty diff when its system prompt over-permits a "no change needed"
 * answer. The diff-based executor already has an empty-diff
 * short-circuit upstream of the commit; this validator catches the
 * same shape AT the post-commit boundary so a different executor
 * (agentic, external workflow, custom adapter) that produced a
 * trivially-empty commit cannot escape the gate.
 *
 * Detection rule (purely structural):
 *   - `touchedPaths.length === 0`  (no files in the commit), OR
 *   - the diff has no `+`/`-` content lines that change a byte
 *
 * Severity: critical. An empty commit reaching the PR-creation step
 * is always a mistake -- either the drafter no-op should have been
 * caught upstream and we surface it as a code-author-revoked, or
 * the executor's stage-path machinery missed something and the
 * resulting PR will be empty.
 */

import type {
  PostCommitValidator,
  PostCommitValidatorInput,
  PostCommitValidatorResult,
} from '../../../src/substrate/post-commit-validator.js';

export class EmptyDiffValidator implements PostCommitValidator {
  readonly name = 'empty-diff-validator';

  async validate(input: PostCommitValidatorInput): Promise<PostCommitValidatorResult> {
    if (input.touchedPaths.length === 0) {
      return {
        ok: false,
        severity: 'critical',
        reason: 'commit touched no files (touchedPaths is empty)',
      };
    }
    if (!hasContentChange(input.diff)) {
      return {
        ok: false,
        severity: 'critical',
        reason: 'commit diff has no content-changing +/- lines',
      };
    }
    return { ok: true };
  }
}

/**
 * Returns true when the unified diff contains at least one line
 * beginning with `+` or `-` that is not a diff header (`+++ b/...`,
 * `--- a/...`) and is not an empty marker (`+`, `-`).
 *
 * Why "any content change" rather than "any added line": a commit
 * whose only effect is removing a file still has body-side
 * `-` lines but no `+` lines, and is a legitimate non-empty
 * commit. The presence of one body-side `+` or `-` outside the
 * header rows is the structural floor.
 */
function hasContentChange(diff: string): boolean {
  if (diff.length === 0) return false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line === '+' || line === '-') continue;
    if (line.startsWith('+') || line.startsWith('-')) return true;
  }
  return false;
}
