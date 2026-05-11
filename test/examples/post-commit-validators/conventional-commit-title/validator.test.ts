import { describe, it, expect } from 'vitest';
import { ConventionalCommitTitleValidator } from '../../../../examples/post-commit-validators/conventional-commit-title/index.js';
import type { PostCommitValidatorInput } from '../../../../src/substrate/post-commit-validator.js';

const BASE: PostCommitValidatorInput = Object.freeze({
  commitSha: 'a'.repeat(40),
  branchName: 'code-author/plan-test-abc123',
  repoDir: '/tmp/repo',
  diff: '',
  touchedPaths: Object.freeze(['src/example.ts']),
  plan: Object.freeze({
    id: 'plan-test',
    target_paths: Object.freeze(['src/example.ts']),
    delegation: null,
  }),
  authorIdentity: Object.freeze({
    name: 'lag-ceo',
    email: 'lag-ceo[bot]@users.noreply.github.com',
  }),
});

function buildValidator(subject: string) {
  return new ConventionalCommitTitleValidator({
    readSubject: () => subject,
  });
}

describe('ConventionalCommitTitleValidator', () => {
  it('accepts a valid feat title without scope', async () => {
    const v = buildValidator('feat: ship new post-commit validator seam');
    const out = await v.validate(BASE);
    expect(out.ok).toBe(true);
  });

  it('accepts a valid fix title with scope', async () => {
    const v = buildValidator('fix(substrate): rebuild plan index on cold start');
    const out = await v.validate(BASE);
    expect(out.ok).toBe(true);
  });

  it('rejects a capitalized description', async () => {
    const v = buildValidator('feat: Ship new post-commit validator seam');
    const out = await v.validate(BASE);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('major');
      expect(out.reason).toMatch(/Conventional Commits/);
    }
  });

  it('rejects a missing colon', async () => {
    const v = buildValidator('feat ship new post-commit validator seam');
    const out = await v.validate(BASE);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('major');
      expect(out.reason).toMatch(/Conventional Commits/);
    }
  });

  it('rejects an unknown type', async () => {
    const v = buildValidator('whatever: ship new post-commit validator seam');
    const out = await v.validate(BASE);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('major');
      expect(out.reason).toMatch(/Conventional Commits/);
    }
  });

  it('rejects a trailing period on the description', async () => {
    const v = buildValidator('feat: ship new post-commit validator seam.');
    const out = await v.validate(BASE);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('major');
      expect(out.reason).toMatch(/trailing period/);
    }
  });
});
