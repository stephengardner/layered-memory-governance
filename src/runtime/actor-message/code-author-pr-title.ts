/**
 * Shared helper that builds Conventional-Commits-shaped titles for
 * autonomous PRs opened by code-author executors.
 *
 * Two call sites depend on the same logic:
 *
 *   - examples-side `agentic-code-author-executor.createPrViaGhClient`
 *     (the substrate-deep path; PR title derives from the plan atom's
 *     metadata.title).
 *   - examples-side `diff-based-code-author-executor.buildPrTitle`
 *     (the legacy single-shot path; same shape).
 *
 * Both used to hardcode `code-author: <plan title>` which fails the
 * `dev-pr-titles-conventional-commits` canon directive: PR titles MUST
 * start with `<type>(<scope>): <description>` where type is one of
 * feat | fix | docs | style | refactor | perf | test | build | ci |
 * chore | revert. `code-author:` is not a valid type, so reviewers
 * (CR + auditor) flag every autonomous PR as non-conforming until the
 * driver agent renames it manually.
 *
 * Behavior:
 *
 *   - If the plan title already starts with a conventional-commits
 *     prefix (`feat:`, `feat(scope):`, `fix(...):` etc), pass it
 *     through as-is. The plan author has already shaped it.
 *   - Otherwise prepend `feat(autonomous):` so the PR title becomes
 *     `feat(autonomous): <plan title>`. `feat` because most plans
 *     introduce new behavior; `autonomous` as the scope so a release-
 *     notes generator can group autonomous PRs together for audit.
 *
 * Why a shared helper rather than the two existing inline copies:
 * canon `dev-no-duplication-beyond-n2`. Extract at N=2 so the next
 * call site (a future PR-fix executor, the resume-author wrapper, a
 * Slack-driven autonomous PR flow) inherits the same shape without
 * a third copy that drifts.
 */

/**
 * Conventional Commits type allowlist mirroring the canon directive.
 * Kept in sync with `dev-pr-titles-conventional-commits` content;
 * adding a new type to the canon means adding it here too.
 */
const CONVENTIONAL_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

/**
 * Match `<type>:` or `<type>(<scope>):` at the start of a string.
 * The trailing `:` is mandatory; types without it are treated as
 * prose (a sentence beginning with the word "feat" should not be
 * misclassified). Case-sensitive: Conventional Commits is lowercase.
 */
const CONVENTIONAL_PREFIX_RE = new RegExp(
  `^(?:${CONVENTIONAL_TYPES.join('|')})(?:\\([^)\\n]+\\))?:[ \\t]+\\S`,
);

/**
 * Build a Conventional-Commits-shaped PR title for an autonomous
 * code-author run. Pass through plan titles that already conform;
 * prefix non-conforming titles with `feat(autonomous):`.
 *
 * Pure: returns a new string; never mutates inputs.
 */
export function buildConventionalCommitsPrTitle(planTitle: string): string {
  const trimmed = planTitle.trim();
  if (trimmed.length === 0) return 'feat(autonomous): plan';
  if (CONVENTIONAL_PREFIX_RE.test(trimmed)) return trimmed;
  return `feat(autonomous): ${trimmed}`;
}
