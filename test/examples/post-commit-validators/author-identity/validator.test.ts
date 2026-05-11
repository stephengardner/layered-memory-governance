import { describe, it, expect } from 'vitest';
import { AuthorIdentityValidator } from '../../../../examples/post-commit-validators/author-identity/index.js';
import type { PostCommitValidatorInput } from '../../../../src/substrate/post-commit-validator.js';

function buildInput(email: string): PostCommitValidatorInput {
  return Object.freeze({
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
      email,
    }),
  });
}

describe('AuthorIdentityValidator', () => {
  it('accepts a bot email matching an allowed suffix', async () => {
    const v = new AuthorIdentityValidator({
      allowedEmailSuffixes: ['@users.noreply.github.com'],
    });
    const out = await v.validate(buildInput('lag-ceo[bot]@users.noreply.github.com'));
    expect(out.ok).toBe(true);
  });

  it('rejects an operator email that does not match any allowed suffix', async () => {
    const v = new AuthorIdentityValidator({
      allowedEmailSuffixes: ['@users.noreply.github.com'],
    });
    const out = await v.validate(buildInput('stephen@example.com'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
      // Local-part must be redacted; only the domain/suffix survives
      // so the reason carries enough signal for an operator to
      // diagnose the wrong-suffix case without leaking PII into
      // audit atoms.
      expect(out.reason).not.toContain('stephen');
      expect(out.reason).toContain('<redacted>@example.com');
    }
  });

  it('rejects every email when the allow-list is empty', async () => {
    const v = new AuthorIdentityValidator({ allowedEmailSuffixes: [] });
    const out = await v.validate(buildInput('lag-ceo[bot]@users.noreply.github.com'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
      // Local-part redaction also applies to the bot address in
      // this failure case; only the domain survives.
      expect(out.reason).toContain('<redacted>@users.noreply.github.com');
    }
  });

  it('refuses to allow-all when an empty-string suffix is supplied (fail-closed)', async () => {
    // `''.endsWith('')` is true in plain JS; without filtering the
    // constructor would silently flip the validator into allow-all.
    // The substrate's fail-closed posture is to filter empties out
    // so an accidental blank entry does not disable the gate.
    const v = new AuthorIdentityValidator({
      allowedEmailSuffixes: ['', '   '],
    });
    const out = await v.validate(buildInput('stephen@example.com'));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.severity).toBe('critical');
    }
  });

  it('matches case-insensitively (substrate normalizes both sides)', async () => {
    // GitHub's noreply addresses are lowercase; some clients may
    // carry uppercase fragments through. A case-mismatch must not
    // sneak past the gate.
    const v = new AuthorIdentityValidator({
      allowedEmailSuffixes: ['@USERS.NOREPLY.GITHUB.COM'],
    });
    const out = await v.validate(buildInput('lag-ceo[bot]@users.noreply.github.com'));
    expect(out.ok).toBe(true);
  });
});
