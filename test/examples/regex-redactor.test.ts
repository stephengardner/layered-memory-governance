import { describe, it, expect } from 'vitest';
import { RegexRedactor } from '../../examples/redactors/regex-default/index.js';
import { runRedactorContract } from '../substrate/redactor-contract.test.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const CTX = { kind: 'tool-result' as const, principal: 'p' as PrincipalId };

describe('RegexRedactor: default patterns', () => {
  it('redacts AWS access keys', () => {
    const r = new RegexRedactor();
    const out = r.redact('see key AKIAIOSFODNN7EXAMPLE in logs', CTX);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED:aws-access-key]');
  });

  it('redacts GitHub PATs', () => {
    const r = new RegexRedactor();
    const out = r.redact('token ghp_abcdefghijklmnopqrstuvwxyzABCDEF1234 here', CTX);
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyzABCDEF1234');
    expect(out).toContain('[REDACTED:github-pat]');
  });

  it('redacts GitHub installation tokens', () => {
    const r = new RegexRedactor();
    const out = r.redact('ghs_TestTokenAbcdefghijklmnopqrstuvwxyzAB seen', CTX);
    expect(out).not.toContain('ghs_TestTokenAbcdefghijklmnopqrstuvwxyzAB');
    expect(out).toContain('[REDACTED:github-installation-token]');
  });

  it('redacts GitHub OAuth tokens', () => {
    const r = new RegexRedactor();
    const out = r.redact('gho_abcdefghijklmnopqrstuvwxyzABCDEF1234 user', CTX);
    expect(out).not.toContain('gho_abcdefghijklmnopqrstuvwxyzABCDEF1234');
    expect(out).toContain('[REDACTED:github-oauth]');
  });

  it('does not flag prose that happens to contain ghp', () => {
    const r = new RegexRedactor();
    const out = r.redact('I think ghp is short for github-personal', CTX);
    expect(out).toBe('I think ghp is short for github-personal');
  });

  it('is idempotent over already-redacted text', () => {
    const r = new RegexRedactor();
    const once = r.redact('AKIAIOSFODNN7EXAMPLE', CTX);
    const twice = r.redact(once, CTX);
    expect(twice).toBe(once);
  });

  it('throws on non-string input (defensive contract)', () => {
    const r = new RegexRedactor();
    expect(() => r.redact(undefined as unknown as string, CTX)).toThrow(/expected string/);
    expect(() => r.redact(42 as unknown as string, CTX)).toThrow(/expected string/);
    expect(() => r.redact(null as unknown as string, CTX)).toThrow(/expected string/);
  });

  it('accepts custom pattern set', () => {
    const r = new RegexRedactor([
      { name: 'org-customer-id', pattern: /\bCUST-[A-Z0-9]{12}\b/g, replacement: '[REDACTED:customer-id]' },
    ]);
    const out = r.redact('user CUST-ABCDEF123456 is active', CTX);
    expect(out).toContain('[REDACTED:customer-id]');
    expect(out).not.toContain('CUST-ABCDEF123456');
  });
});

// Run the contract test against the reference adapter.
runRedactorContract('RegexRedactor', () => new RegexRedactor());
