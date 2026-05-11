/**
 * Reference PostCommitValidator: rejects commits whose subject line
 * does not match Conventional Commits (per
 * dev-pr-title-conventional-commits canon).
 *
 * Rationale
 * ---------
 * Conventional Commits powers the audit-chain (release-notes
 * generators, changelog tooling, the operator's "what landed last
 * week" question). PR-side review catches title regressions only
 * after the PR opens; a post-commit gate catches them locally before
 * the executor reaches PR creation.
 *
 * Detection rule:
 *   Subject line MUST match
 *   `/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z][a-z0-9-]*\))?: [a-z]/`
 *
 * The trailing `[a-z]` enforces a lowercase first character of the
 * description (per canon's "Description starts lowercase").
 * The 72-char total cap + "no trailing period" rules are checked
 * separately to keep the failure reasons specific.
 *
 * Severity: major. A non-conforming title is fixable by a `git
 * commit --amend` without redoing the diff, so we surface it as a
 * warning audit atom rather than abort the dispatch. An operator
 * who wants critical semantics passes a wrapping adapter that
 * upgrades the severity.
 *
 * Adapter shape
 * -------------
 * The validator reads the commit subject by spawning `git log -1
 * --format=%s <sha>` in `input.repoDir`. The spawn function is
 * injectable for tests; production callers pass the real
 * `child_process.execFileSync` shim.
 */

import { execFileSync } from 'node:child_process';
import type {
  PostCommitValidator,
  PostCommitValidatorInput,
  PostCommitValidatorResult,
} from '../../../src/substrate/post-commit-validator.js';

const CONVENTIONAL_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z][a-z0-9-]*\))?: [a-z]/;
const MAX_TITLE_LEN = 72;

/**
 * Synchronous shape the validator uses to read the commit subject.
 * Tests inject a stub; production wires `defaultGitSubjectReader`
 * which delegates to `child_process.execFileSync`.
 */
export type GitSubjectReader = (sha: string, repoDir: string) => string;

export function defaultGitSubjectReader(sha: string, repoDir: string): string {
  return execFileSync('git', ['log', '-1', '--format=%s', sha], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim();
}

export interface ConventionalCommitTitleValidatorOptions {
  /** Optional reader override; defaults to the real `git log` shim. */
  readonly readSubject?: GitSubjectReader;
}

export class ConventionalCommitTitleValidator implements PostCommitValidator {
  readonly name = 'conventional-commit-title-validator';
  private readonly readSubject: GitSubjectReader;

  constructor(options: ConventionalCommitTitleValidatorOptions = {}) {
    this.readSubject = options.readSubject ?? defaultGitSubjectReader;
  }

  async validate(input: PostCommitValidatorInput): Promise<PostCommitValidatorResult> {
    let subject: string;
    try {
      subject = this.readSubject(input.commitSha, input.repoDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        severity: 'major',
        reason: `failed to read commit subject for ${input.commitSha}: ${message}`,
      };
    }
    if (subject.length === 0) {
      return {
        ok: false,
        severity: 'major',
        reason: 'commit subject line is empty',
      };
    }
    if (subject.length > MAX_TITLE_LEN) {
      return {
        ok: false,
        severity: 'major',
        reason: `commit subject exceeds ${MAX_TITLE_LEN} chars: ${subject.length} chars`,
      };
    }
    if (subject.endsWith('.')) {
      return {
        ok: false,
        severity: 'major',
        reason: 'commit subject ends with a trailing period',
      };
    }
    if (!CONVENTIONAL_RE.test(subject)) {
      return {
        ok: false,
        severity: 'major',
        reason: `commit subject does not match Conventional Commits: ${JSON.stringify(subject)}`,
      };
    }
    return { ok: true };
  }
}
