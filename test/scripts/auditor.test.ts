import { describe, expect, it } from 'vitest';
import {
  classifyDiffBlastRadius,
  computeVerdict,
  isPrAuthorTrustedForEmbedded,
} from '../../scripts/lib/auditor.mjs';

describe('classifyDiffBlastRadius', () => {
  it('returns docs when only docs/ or *.md files change', () => {
    expect(classifyDiffBlastRadius(['docs/foo.md', 'README.md'])).toBe('docs');
  });
  it('returns tooling when only scripts/ or config changes', () => {
    expect(classifyDiffBlastRadius(['scripts/foo.mjs', 'package.json'])).toBe('tooling');
  });
  it('returns framework when src/ changes', () => {
    expect(classifyDiffBlastRadius(['src/runtime/foo.ts'])).toBe('framework');
  });
  it('returns l3-canon-proposal when scripts/bootstrap-*-canon.mjs changes', () => {
    expect(classifyDiffBlastRadius(['scripts/bootstrap-dev-canon.mjs'])).toBe('l3-canon-proposal');
  });
  it('returns framework for mixed src + tooling', () => {
    expect(classifyDiffBlastRadius(['scripts/x.mjs', 'src/y.ts'])).toBe('framework');
  });
});

describe('computeVerdict', () => {
  it('passes when diff-radius is within envelope', () => {
    expect(computeVerdict({ diffRadius: 'tooling', envelopeMax: 'framework' })).toEqual({ verdict: 'pass', reason: 'within envelope' });
  });
  it('fails when diff-radius exceeds envelope', () => {
    const r = computeVerdict({ diffRadius: 'framework', envelopeMax: 'tooling' });
    expect(r.verdict).toBe('fail');
  });
});

describe('isPrAuthorTrustedForEmbedded', () => {
  // The authorial gate is the load-bearing security check on the
  // embedded-snapshot fallback path: when the on-disk atom store
  // does not have the plan, the auditor reads the PR body's
  // embedded JSON only when the PR was opened by the configured
  // dispatch-bot identity. This raises the body-tampering bar
  // from "anyone with PR-edit access" to "the dispatch bot or a
  // repo admin", matching the bot-identity discipline canon
  // enforces for every other governance-visible action.
  it('accepts the default lag-ceo[bot] author when no allowlist override is supplied', () => {
    expect(isPrAuthorTrustedForEmbedded('lag-ceo[bot]', undefined)).toBe(true);
    expect(isPrAuthorTrustedForEmbedded('lag-ceo[bot]', '')).toBe(true);
  });

  it('rejects an unrelated author under the default allowlist', () => {
    expect(isPrAuthorTrustedForEmbedded('mallory', undefined)).toBe(false);
    expect(isPrAuthorTrustedForEmbedded('coderabbitai[bot]', undefined)).toBe(false);
    expect(isPrAuthorTrustedForEmbedded('stephengardner', undefined)).toBe(false);
  });

  it('honours a comma-separated env-style override allowlist', () => {
    // Deployments that open autonomous PRs under a different
    // dispatch role re-point the gate by setting the env var
    // (e.g. LAG_AUDITOR_TRUSTED_PR_AUTHOR='lag-cto[bot],lag-pr-landing[bot]').
    expect(isPrAuthorTrustedForEmbedded('lag-cto[bot]', 'lag-cto[bot],lag-pr-landing[bot]')).toBe(true);
    expect(isPrAuthorTrustedForEmbedded('lag-pr-landing[bot]', 'lag-cto[bot],lag-pr-landing[bot]')).toBe(true);
    expect(isPrAuthorTrustedForEmbedded('lag-ceo[bot]', 'lag-cto[bot],lag-pr-landing[bot]')).toBe(false);
  });

  it('trims whitespace around comma-separated entries', () => {
    // Operators editing the env value by hand commonly pad
    // commas with spaces; the parser must accept both.
    expect(isPrAuthorTrustedForEmbedded('a-bot', '  a-bot  ,  b-bot  ')).toBe(true);
    expect(isPrAuthorTrustedForEmbedded('b-bot', '  a-bot  ,  b-bot  ')).toBe(true);
    expect(isPrAuthorTrustedForEmbedded('c-bot', '  a-bot  ,  b-bot  ')).toBe(false);
  });

  it('returns false on empty / null / undefined author login (fail-closed)', () => {
    // A missing author login is the gh-CLI failure signature for
    // a deleted-account author or a permissions-stripped read; the
    // fail-closed behaviour prevents an empty-author PR from
    // bypassing the carrier gate.
    expect(isPrAuthorTrustedForEmbedded('', undefined)).toBe(false);
    expect(isPrAuthorTrustedForEmbedded(null, undefined)).toBe(false);
    expect(isPrAuthorTrustedForEmbedded(undefined, undefined)).toBe(false);
  });

  it('rejects a substring or prefix-match against an allowlisted entry', () => {
    // Defence in depth: a substring match on the allowlist would
    // accept an attacker login like 'lag-ceo[bot]-evil' that
    // begins with the allowlisted prefix. Exact equality only.
    expect(isPrAuthorTrustedForEmbedded('lag-ceo', undefined)).toBe(false);
    expect(isPrAuthorTrustedForEmbedded('lag-ceo[bot]-evil', undefined)).toBe(false);
    expect(isPrAuthorTrustedForEmbedded('-lag-ceo[bot]', undefined)).toBe(false);
  });
});
