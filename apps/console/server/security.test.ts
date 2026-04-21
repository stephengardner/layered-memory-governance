import { describe, it, expect } from 'vitest';
import {
  atomFilenameFromId,
  DEFAULT_ALLOWED_ORIGINS,
  isAllowedOrigin,
  makeAllowedOriginSet,
} from './security';

/*
 * Regression tests for the server's security helpers. Each suite
 * corresponds to a CodeRabbit critical that was flagged on PR #78
 * and must not regress.
 */

describe('atomFilenameFromId', () => {
  it('accepts canonical atom ids', () => {
    expect(atomFilenameFromId('arch-atomstore-source-of-truth')).toBe('arch-atomstore-source-of-truth.json');
    expect(atomFilenameFromId('op-action-lag-ceo-1776788807338-24a2b391')).toBe(
      'op-action-lag-ceo-1776788807338-24a2b391.json',
    );
    expect(atomFilenameFromId('prop-xyz-20260421163000-abc123')).toBe('prop-xyz-20260421163000-abc123.json');
    // Dots are allowed (we use them in versioned ids like `a.b.c`).
    expect(atomFilenameFromId('v1.0.2')).toBe('v1.0.2.json');
  });

  it('rejects path-traversal attempts', () => {
    // This is the canonical CodeRabbit Critical: a crafted id that
    // would escape ATOMS_DIR when join()'d. Before the guard, the
    // server would read/write an arbitrary JSON on disk.
    expect(() => atomFilenameFromId('../principals/root')).toThrow(/invalid atom id/);
    expect(() => atomFilenameFromId('..')).toThrow();
    expect(() => atomFilenameFromId('../../etc/passwd')).toThrow();
    expect(() => atomFilenameFromId('a/b')).toThrow();
    expect(() => atomFilenameFromId('a\\b')).toThrow();
  });

  it('rejects empty and leading-dot ids', () => {
    expect(() => atomFilenameFromId('')).toThrow();
    // Leading dot is rejected so `.hidden` files aren't reachable.
    expect(() => atomFilenameFromId('.hidden')).toThrow();
    // Leading dash is rejected by the anchor (`[A-Za-z0-9]`) so
    // someone can't pass `-rf` and trip a shell lookalike later.
    expect(() => atomFilenameFromId('-rm-rf')).toThrow();
  });

  it('rejects url-encoded traversal attempts', () => {
    expect(() => atomFilenameFromId('%2e%2e/foo')).toThrow();
    expect(() => atomFilenameFromId('foo%00.json')).toThrow();
  });

  it('attaches a recognizable error code so routes can map to 400', () => {
    try {
      atomFilenameFromId('../x');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('invalid-atom-id');
    }
  });
});

describe('makeAllowedOriginSet', () => {
  it('includes the in-repo defaults when env is empty', () => {
    const s = makeAllowedOriginSet(undefined);
    for (const o of DEFAULT_ALLOWED_ORIGINS) expect(s.has(o)).toBe(true);
  });

  it('merges comma-separated extras from env', () => {
    const s = makeAllowedOriginSet('https://console.acme.corp, https://lag.internal:8443');
    expect(s.has('https://console.acme.corp')).toBe(true);
    expect(s.has('https://lag.internal:8443')).toBe(true);
    // Defaults still present.
    for (const o of DEFAULT_ALLOWED_ORIGINS) expect(s.has(o)).toBe(true);
  });

  it('ignores blanks and trims whitespace in env extras', () => {
    const s = makeAllowedOriginSet('  ,  https://a.example , ,   , https://b.example  ');
    expect(s.has('https://a.example')).toBe(true);
    expect(s.has('https://b.example')).toBe(true);
    expect(s.has('')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = makeAllowedOriginSet(undefined);

  it('returns true for missing Origin (same-origin/native/curl/tests)', () => {
    expect(isAllowedOrigin(allowed, undefined)).toBe(true);
    expect(isAllowedOrigin(allowed, '')).toBe(true);
  });

  it('returns true for allowlisted origins', () => {
    expect(isAllowedOrigin(allowed, 'http://localhost:9080')).toBe(true);
    expect(isAllowedOrigin(allowed, 'http://127.0.0.1:9080')).toBe(true);
  });

  it('returns false for foreign origins (blocks cross-origin writes)', () => {
    /*
     * The CodeRabbit Critical was: `*` CORS + write endpoints at
     * localhost:9081 let any visited webpage preflight + POST. Test
     * that the policy rejects the specific shapes an attacker would
     * try.
     */
    expect(isAllowedOrigin(allowed, 'https://evil.example')).toBe(false);
    expect(isAllowedOrigin(allowed, 'https://phishing.test')).toBe(false);
    expect(isAllowedOrigin(allowed, 'http://localhost:9080.evil.example')).toBe(false);
    expect(isAllowedOrigin(allowed, 'null')).toBe(false);
  });

  it('is strict on scheme and port (http vs https, port-specific)', () => {
    // Same host, different scheme — not auto-allowed.
    expect(isAllowedOrigin(allowed, 'https://localhost:9080')).toBe(false);
    // Same host+scheme, different port — not auto-allowed.
    expect(isAllowedOrigin(allowed, 'http://localhost:9999')).toBe(false);
  });
});
