import { describe, it, expect } from 'vitest';
import {
  BLAST_RADIUS_VALUES,
  DEFAULT_EXPIRES,
  DEFAULT_MIN_CONFIDENCE,
  EXPIRES_PRESETS,
  isFormValid,
  SCOPE_VALUES,
  SUB_ACTOR_VALUES,
  validateFileIntentForm,
} from './fileIntent.service';

/*
 * Unit tests for the FileIntentPanel feature. Pure-helper coverage only.
 *
 * The vitest config runs under environment: 'node' (vitest.config.ts);
 * adding jsdom + RTL to exercise this card would inflate CI install
 * time for behaviour the (forthcoming) Playwright spec already covers.
 * Mirror the pattern used by `pipelines-viewer/IntentOutcomeCard.test.tsx`:
 * pure resolvers under vitest, live-DOM under Playwright.
 *
 * Coverage focus:
 *   - validateFileIntentForm enforces the inline-error rules the panel
 *     keys aria-invalid + the inline error text off.
 *   - The enum constants must stay in sync with the server contract
 *     (`server/file-intent.ts`); a mismatch silently breaks form
 *     submission with a 400 response from the backend.
 */

describe('validateFileIntentForm', () => {
  it('passes when request and sub-actors are populated', () => {
    const errors = validateFileIntentForm({
      request: 'Add a TODO badge to the plans header',
      subActors: ['code-author'],
    });
    expect(errors).toEqual({});
    expect(isFormValid(errors)).toBe(true);
  });

  it('flags an empty request with a friendly message', () => {
    const errors = validateFileIntentForm({ request: '', subActors: ['code-author'] });
    expect(errors.request).toBeTruthy();
    expect(errors.request).toMatch(/Describe the intent/i);
    expect(isFormValid(errors)).toBe(false);
  });

  it('flags a whitespace-only request', () => {
    const errors = validateFileIntentForm({ request: '   \n  ', subActors: ['code-author'] });
    expect(errors.request).toBeTruthy();
  });

  it('flags a too-short request', () => {
    const errors = validateFileIntentForm({ request: 'fix it', subActors: ['code-author'] });
    expect(errors.request).toBeTruthy();
    expect(errors.request).toMatch(/too short/i);
  });

  it('flags missing sub-actors', () => {
    const errors = validateFileIntentForm({
      request: 'Add a TODO badge to the plans header',
      subActors: [],
    });
    expect(errors.subActors).toBeTruthy();
  });

  it('flags both errors simultaneously', () => {
    const errors = validateFileIntentForm({ request: '', subActors: [] });
    expect(errors.request).toBeTruthy();
    expect(errors.subActors).toBeTruthy();
    expect(isFormValid(errors)).toBe(false);
  });
});

describe('isFormValid', () => {
  it('returns true for empty errors', () => {
    expect(isFormValid({})).toBe(true);
  });

  it('returns false when any error key is set', () => {
    expect(isFormValid({ request: 'bad' })).toBe(false);
    expect(isFormValid({ subActors: 'bad' })).toBe(false);
  });
});

describe('frontend wire constants', () => {
  /*
   * These constants ARE the wire contract with `server/file-intent.ts`.
   * A drift makes the form silently submit values the server rejects;
   * pinning each list here forces a paired update to keep the two
   * halves in sync. Per canon `dec-canon-as-projection-of-substrate`,
   * the wire shape is one of the substrate's load-bearing seams.
   */
  it('SCOPE_VALUES matches the server contract', () => {
    expect(SCOPE_VALUES).toEqual(['tooling', 'docs', 'framework', 'canon']);
  });

  it('BLAST_RADIUS_VALUES matches the server contract', () => {
    expect(BLAST_RADIUS_VALUES).toEqual(['none', 'docs', 'tooling', 'framework', 'l3-canon-proposal']);
  });

  it('SUB_ACTOR_VALUES matches the v1 canon allowlist', () => {
    expect(SUB_ACTOR_VALUES).toEqual(['code-author', 'auditor-actor']);
  });

  it('exposes EXPIRES_PRESETS within the 72h safety cap', () => {
    expect(EXPIRES_PRESETS.length).toBeGreaterThan(0);
    for (const p of EXPIRES_PRESETS) {
      const m = /^(\d+)([hm])$/.exec(p.value);
      expect(m, `preset value ${p.value} must match Nh|Nm`).not.toBeNull();
      if (!m) continue;
      const n = Number(m[1]);
      const unit = m[2];
      const hours = unit === 'h' ? n : n / 60;
      expect(hours).toBeLessThanOrEqual(72);
    }
  });

  it('DEFAULT_EXPIRES is one of the presets', () => {
    expect(EXPIRES_PRESETS.some((p) => p.value === DEFAULT_EXPIRES)).toBe(true);
  });

  it('DEFAULT_MIN_CONFIDENCE matches the CLI default', () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.75);
  });
});
