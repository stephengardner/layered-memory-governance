/**
 * Shared helper that builds Conventional-Commits-shaped titles for
 * automation-opened pull requests.
 *
 * Code-author executors (any path that drafts a PR from a plan atom)
 * historically formed titles by concatenating a fixed prefix to the
 * plan title. That fixed prefix was not a Conventional Commits type
 * (`feat | fix | docs | style | refactor | perf | test | build | ci |
 * chore | revert`), so every autonomous PR opened with a non-conforming
 * title and required a downstream rename. Two callers in this module
 * directory invoked this helper at N=2 once the canon directive
 * required Conventional Commits; further callers reuse the same
 * primitive rather than embedding a third copy that can drift.
 *
 * Behavior:
 *
 *   - If the plan title already starts with a Conventional Commits
 *     prefix (`feat:`, `feat(scope):`, `fix(...):` etc), pass it
 *     through as-is. The drafter has already shaped it.
 *   - Otherwise prepend `feat(autonomous):` so the PR title becomes
 *     `feat(autonomous): <plan title>`. `feat` because most plans
 *     introduce new behavior; `autonomous` as the scope so a release-
 *     notes generator can group automation-opened PRs together for
 *     audit.
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
