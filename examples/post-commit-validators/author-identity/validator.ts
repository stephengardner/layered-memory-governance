/**
 * Reference PostCommitValidator: rejects commits whose author email
 * does not end in one of the configured allow-list suffixes.
 *
 * Rationale
 * ---------
 * Every commit on autonomous-flow branches MUST be attributed to a
 * bot identity (lag-ceo / lag-cto / lag-pr-landing / machine user)
 * per canon dev-bot-identity-required-for-gh-actions. A drafter or
 * agent loop that picks up the operator's personal git config would
 * stamp the commit with the operator's email and break the
 * attribution invariant; PR-side branch protection catches some of
 * this but only after the push.
 *
 * Detection rule:
 *   `authorIdentity.email` MUST end with one of
 *   `options.allowedEmailSuffixes` (case-insensitive).
 *   Otherwise: critical.
 *
 * Severity: critical. An operator-attributed commit reaching this
 * stage is a discipline failure that must abort the dispatch.
 *
 * Case-insensitivity note
 * -----------------------
 * Email comparisons are case-insensitive per RFC 5321 (the local
 * part is technically case-sensitive but no widely-deployed system
 * relies on that; GitHub's noreply addresses are lowercase). The
 * substrate normalizes both sides to lowercase before suffix-match.
 */

import type {
  PostCommitValidator,
  PostCommitValidatorInput,
  PostCommitValidatorResult,
} from '../../../src/substrate/post-commit-validator.js';

export interface AuthorIdentityValidatorOptions {
  /**
   * Suffixes the author email is allowed to end with. Comparison is
   * case-insensitive. An empty list rejects every commit: the
   * substrate ships no implicit allow-list because the right shape
   * is deployment-specific (org-internal noreply domains, machine
   * user accounts, etc.).
   */
  readonly allowedEmailSuffixes: ReadonlyArray<string>;
}

export class AuthorIdentityValidator implements PostCommitValidator {
  readonly name = 'author-identity-validator';
  private readonly allowedLower: ReadonlyArray<string>;

  constructor(options: AuthorIdentityValidatorOptions) {
    // Trim + lowercase each suffix; drop empties so an accidental
    // empty entry (`''`) does not become an allow-all (every
    // `email.endsWith('')` is true). A deployment that really wants
    // empty-suffix semantics passes a separate adapter; the
    // substrate's posture is fail-closed.
    this.allowedLower = Object.freeze(
      options.allowedEmailSuffixes
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    );
  }

  async validate(input: PostCommitValidatorInput): Promise<PostCommitValidatorResult> {
    const rawEmail = input.authorIdentity.email;
    const email = rawEmail.toLowerCase();
    for (const suffix of this.allowedLower) {
      if (email.endsWith(suffix)) return { ok: true };
    }
    // Redact the local-part of the email before it enters the
    // failure reason. The reason flows into audit atoms and
    // observation metadata; storing full author emails increases
    // PII exposure for no governance benefit. The domain/suffix is
    // retained so an operator can still tell "the commit came from
    // example.com instead of users.noreply.github.com".
    const redactedEmail = rawEmail.replace(/^[^@]+/, '<redacted>');
    return {
      ok: false,
      severity: 'critical',
      reason: `commit author email ${JSON.stringify(redactedEmail)} does not end with any allowed suffix`,
    };
  }
}
