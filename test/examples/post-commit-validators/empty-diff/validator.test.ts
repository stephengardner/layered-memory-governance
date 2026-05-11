import { describe, it, expect } from 'vitest';
import { EmptyDiffValidator } from '../../../../examples/post-commit-validators/empty-diff/index.js';
import type { PostCommitValidatorInput } from '../../../../src/substrate/post-commit-validator.js';

const BASE: PostCommitValidatorInput = Object.freeze({
  commitSha: 'a'.repeat(40),
  branchName: 'code-author/plan-test-abc123',
  repoDir: '/tmp/repo',
  diff: '',
  touchedPaths: Object.freeze([] as readonly string[]),
  plan: Object.freeze({
    id: 'plan-test',
    target_paths: Object.freeze([] as readonly string[]),
    delegation: null,
  }),
  authorIdentity: Object.freeze({
    name: 'lag-ceo',
    email: 'lag-ceo[bot]@users.noreply.github.com',
  }),
});

const SINGLE_LINE_DIFF = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index e69de29..3b18e51 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -0,0 +1 @@',
  '+hello world',
  '',
].join('\n');

const MULTI_FILE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,1 @@',
  '-old line',
  '+new line',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -0,0 +1 @@',
  '+new file content',
  '',
].join('\n');

const BINARY_ONLY_DIFF = [
  'diff --git a/img/logo.png b/img/logo.png',
  'index 0123456..789abcd 100644',
  'Binary files a/img/logo.png and b/img/logo.png differ',
  '',
].join('\n');

describe('EmptyDiffValidator', () => {
  it('rejects an empty commit (no touchedPaths)', async () => {
    const v = new EmptyDiffValidator();
    const out = await v.validate({ ...BASE, diff: '', touchedPaths: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
      expect(out.reason).toMatch(/empty|no files|touched no files/i);
    }
  });

  it('accepts a single-line change with a touchedPath', async () => {
    const v = new EmptyDiffValidator();
    const out = await v.validate({
      ...BASE,
      diff: SINGLE_LINE_DIFF,
      touchedPaths: ['src/example.ts'],
    });
    expect(out.ok).toBe(true);
  });

  it('accepts a multi-file commit', async () => {
    const v = new EmptyDiffValidator();
    const out = await v.validate({
      ...BASE,
      diff: MULTI_FILE_DIFF,
      touchedPaths: ['src/a.ts', 'src/b.ts'],
    });
    expect(out.ok).toBe(true);
  });

  it('rejects a binary-only diff with no +/- content lines as critical', async () => {
    // A binary-only commit is structurally a "no content change"
    // case for our heuristic; the validator's job is to refuse it
    // so a deployment that wants binary commits supplies a different
    // adapter. This codifies the substrate-layer policy: ANY commit
    // reaching the post-commit gate without a +/- text-side change
    // is suspect.
    const v = new EmptyDiffValidator();
    const out = await v.validate({
      ...BASE,
      diff: BINARY_ONLY_DIFF,
      touchedPaths: ['img/logo.png'],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
      expect(out.reason).toMatch(/no content-changing/i);
    }
  });
});
