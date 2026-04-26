import { describe, it, expect } from 'vitest';
import { formatClarifyStubTitle } from './clarifyStubTitle';

/*
 * Pure-function tests for the clarify-stub title normalizer. Covers:
 * - non-clarify titles fall through (null);
 * - clarify titles with a known error subtype get a parenthesised
 *   suffix and preserve the raw original;
 * - clarify titles with no recognisable subtype (e.g. older format,
 *   parse failure, unrelated prefix-match) return the generic label
 *   and still preserve the raw original.
 */

const RAW_BUDGET = `Clarify: cannot draft a grounded plan (LLM draft failed: Claude CLI exit=1: stdout={"type":"result","subtype":"error_max_budget_usd","duration_ms":113432,"is_error":true})`;
const RAW_TURN_CAP = `Clarify: cannot draft a grounded plan (LLM draft failed: Claude CLI exit=1: stdout={"type":"result","subtype":"error_max_turns","duration_ms":42100,"is_error":true})`;
const RAW_GENERIC = `Clarify: cannot draft a grounded plan (LLM draft failed: timeout after 60000ms)`;
const RAW_UNKNOWN_SUBTYPE = `Clarify: cannot draft a grounded plan (LLM draft failed: stdout={"subtype":"error_some_future_thing","details":"x"})`;

describe('formatClarifyStubTitle', () => {
  it('returns null for non-clarify titles', () => {
    expect(formatClarifyStubTitle('Some other plan title')).toBeNull();
    expect(formatClarifyStubTitle('Render Clarify-stub plan titles cleanly')).toBeNull();
    expect(formatClarifyStubTitle('')).toBeNull();
  });

  it('recognises error_max_budget_usd', () => {
    const out = formatClarifyStubTitle(RAW_BUDGET);
    expect(out).not.toBeNull();
    expect(out?.label).toBe('Clarify: LLM draft failed (budget exceeded)');
    expect(out?.raw).toBe(RAW_BUDGET);
  });

  it('recognises error_max_turns', () => {
    const out = formatClarifyStubTitle(RAW_TURN_CAP);
    expect(out).not.toBeNull();
    expect(out?.label).toBe('Clarify: LLM draft failed (turn cap)');
    expect(out?.raw).toBe(RAW_TURN_CAP);
  });

  it('falls back to a generic label when no subtype is embedded', () => {
    const out = formatClarifyStubTitle(RAW_GENERIC);
    expect(out).not.toBeNull();
    expect(out?.label).toBe('Clarify: LLM draft failed');
    expect(out?.raw).toBe(RAW_GENERIC);
  });

  it('falls back to a generic label when the subtype is unknown', () => {
    const out = formatClarifyStubTitle(RAW_UNKNOWN_SUBTYPE);
    expect(out).not.toBeNull();
    expect(out?.label).toBe('Clarify: LLM draft failed');
    expect(out?.raw).toBe(RAW_UNKNOWN_SUBTYPE);
  });

  it('rejects non-string inputs without throwing', () => {
    // Defensive: PlanAtom.content is typed `string`, but render-layer
    // helpers should never explode on unexpected runtime data.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatClarifyStubTitle(undefined as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatClarifyStubTitle(null as any)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatClarifyStubTitle(42 as any)).toBeNull();
  });
});
