import { describe, it, expect } from 'vitest';
import { TargetPathsValidator } from '../../../../examples/post-commit-validators/target-paths/index.js';
import type { PostCommitValidatorInput } from '../../../../src/substrate/post-commit-validator.js';

function buildInput(
  overrides: {
    readonly touchedPaths?: ReadonlyArray<string>;
    readonly target_paths?: ReadonlyArray<string>;
  } = {},
): PostCommitValidatorInput {
  return Object.freeze({
    commitSha: 'a'.repeat(40),
    branchName: 'code-author/plan-test-abc123',
    repoDir: '/tmp/repo',
    diff: '',
    touchedPaths: overrides.touchedPaths ?? Object.freeze([] as readonly string[]),
    plan: Object.freeze({
      id: 'plan-test',
      target_paths: overrides.target_paths ?? Object.freeze([] as readonly string[]),
      delegation: null,
    }),
    authorIdentity: Object.freeze({
      name: 'lag-ceo',
      email: 'lag-ceo[bot]@users.noreply.github.com',
    }),
  });
}

describe('TargetPathsValidator', () => {
  it('accepts when every touched path is declared on the plan', async () => {
    const v = new TargetPathsValidator();
    const out = await v.validate(buildInput({
      touchedPaths: ['src/a.ts', 'src/b.ts'],
      target_paths: ['src/a.ts', 'src/b.ts'],
    }));
    expect(out.ok).toBe(true);
  });

  it('rejects when a touched path is not declared on the plan', async () => {
    const v = new TargetPathsValidator();
    const out = await v.validate(buildInput({
      touchedPaths: ['src/a.ts', 'src/uninvited.ts'],
      target_paths: ['src/a.ts'],
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
      expect(out.reason).toContain('src/uninvited.ts');
    }
  });

  it('rejects every touched path when plan.target_paths is empty', async () => {
    const v = new TargetPathsValidator();
    const out = await v.validate(buildInput({
      touchedPaths: ['src/a.ts'],
      target_paths: [],
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
      expect(out.reason).toContain('src/a.ts');
    }
  });

  it('does NOT treat target_paths as a glob pattern (substring-style match is rejected)', async () => {
    // The plan declares `src/` (looks glob-ish). The touched path
    // is `src/a.ts`. Exact-string semantics mean this fails: the
    // declared prefix is not the touched filename.
    const v = new TargetPathsValidator();
    const out = await v.validate(buildInput({
      touchedPaths: ['src/a.ts'],
      target_paths: ['src/'],
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
      expect(out.reason).toContain('src/a.ts');
    }
  });

  it('treats case as significant (substrate does not normalize)', async () => {
    // Filesystem case-insensitivity is the filesystem's job; the
    // substrate compares byte-strings. A commit that touched
    // `src/A.ts` against a plan declaring `src/a.ts` fails.
    const v = new TargetPathsValidator();
    const out = await v.validate(buildInput({
      touchedPaths: ['src/A.ts'],
      target_paths: ['src/a.ts'],
    }));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
      expect(out.reason).toContain('src/A.ts');
    }
  });
});
