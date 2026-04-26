import { describe, expect, it } from 'vitest';
import { describePrincipal, principalLabel } from './principal-display';

describe('describePrincipal', () => {
  it('maps the bootstrap apex id to Apex Agent', () => {
    const r = describePrincipal('stephen-human');
    expect(r.label).toBe('Apex Agent');
    expect(r.role).toBe('apex');
    expect(r.masked).toBe(true);
    expect(r.id).toBe('stephen-human');
  });

  it('maps the canonical operator-principal id to Apex Agent', () => {
    const r = describePrincipal('operator-principal');
    expect(r.label).toBe('Apex Agent');
    expect(r.role).toBe('apex');
    expect(r.masked).toBe(true);
  });

  it('passes through non-overridden ids verbatim', () => {
    // Actor ids outside the override map keep their verbatim display so the
    // actor identity stays visible in audit views.
    for (const id of ['cto-actor', 'code-author', 'lag-ceo', 'auditor-actor']) {
      const r = describePrincipal(id);
      expect(r.label).toBe(id);
      expect(r.role).toBe('');
      expect(r.masked).toBe(false);
    }
  });

  it('returns the em-dash placeholder for null/undefined/empty', () => {
    expect(describePrincipal(null).label).toBe('—');
    expect(describePrincipal(undefined).label).toBe('—');
    expect(describePrincipal('').label).toBe('—');
  });

  it('preserves the verbatim id when a label is mapped (debug surfaces still need it)', () => {
    const r = describePrincipal('stephen-human');
    expect(r.id).toBe('stephen-human');
  });
});

describe('principalLabel', () => {
  it('returns the same label as describePrincipal(id).label', () => {
    expect(principalLabel('stephen-human')).toBe('Apex Agent');
    expect(principalLabel('cto-actor')).toBe('cto-actor');
    expect(principalLabel(null)).toBe('—');
  });
});
