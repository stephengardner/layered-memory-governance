import { describe, it, expect } from 'vitest';
import type { Redactor, RedactContext } from '../../src/substrate/redactor.js';
import type { PrincipalId } from '../../src/substrate/types.js';

const TEST_CTX: RedactContext = {
  kind: 'tool-result',
  principal: 'test-principal' as PrincipalId,
};

export function runRedactorContract(name: string, build: () => Redactor) {
  describe(`Redactor contract: ${name}`, () => {
    it('is pure: same input yields same output', () => {
      const r = build();
      const s = 'AKIAIOSFODNN7EXAMPLE access key';
      expect(r.redact(s, TEST_CTX)).toBe(r.redact(s, TEST_CTX));
    });

    it('is idempotent: redacting twice equals redacting once', () => {
      const r = build();
      const s = 'AKIAIOSFODNN7EXAMPLE access key';
      const once = r.redact(s, TEST_CTX);
      const twice = r.redact(once, TEST_CTX);
      expect(twice).toBe(once);
    });

    it('does not crash on empty input', () => {
      const r = build();
      expect(r.redact('', TEST_CTX)).toBe('');
    });

    it('does not crash on multi-line input with secrets across lines', () => {
      const r = build();
      const multi = 'line one\nline two\nAKIAIOSFODNN7EXAMPLE\nline four';
      const out = r.redact(multi, TEST_CTX);
      expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });
  });
}

describe('redactor module', () => {
  it('exports the Redactor + RedactContext types', () => {
    // Type-only smoke; module loads.
    const ctx: RedactContext = TEST_CTX;
    expect(ctx.kind).toBe('tool-result');
  });
});
