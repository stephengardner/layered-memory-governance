/**
 * Unit tests for scripts/lib/approval-cycle-gate.mjs.
 *
 * The approval-cycle daemon refuses to start when `--llm=memory` is
 * paired with a sub-actor whose dispatch path calls `host.llm`
 * (today: code-author's drafter step). The alternative is failing
 * at runtime, deep inside the executor, with an opaque "MemoryLLM
 * has no registered response for key <hash>" -- exactly the dogfood
 * footgun this gate exists to surface at startup. These tests pin
 * the decision so a future refactor cannot silently regress the
 * loud-fail behaviour.
 *
 * As per coding guidelines: small, focused cases with literal
 * expected values; no elaborate test helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  LLM_REQUIRING_SUB_ACTORS,
  checkLlmCompatibility,
} from '../../scripts/lib/approval-cycle-gate.mjs';

describe('LLM_REQUIRING_SUB_ACTORS', () => {
  it('contains the canonical set today (code-author only)', () => {
    expect([...LLM_REQUIRING_SUB_ACTORS]).toEqual(['code-author']);
  });

  it('is frozen so a runtime mutation cannot relax the gate', () => {
    expect(Object.isFrozen(LLM_REQUIRING_SUB_ACTORS)).toBe(true);
  });
});

describe('checkLlmCompatibility', () => {
  it('returns null when llm is claude-cli (real adapter is always compatible)', () => {
    expect(
      checkLlmCompatibility({ llm: 'claude-cli', registeredIds: ['code-author'] }),
    ).toBe(null);
    expect(
      checkLlmCompatibility({ llm: 'claude-cli', registeredIds: [] }),
    ).toBe(null);
  });

  it('returns null when llm is memory but no LLM-requiring sub-actor is registered', () => {
    expect(
      checkLlmCompatibility({ llm: 'memory', registeredIds: [] }),
    ).toBe(null);
    expect(
      checkLlmCompatibility({ llm: 'memory', registeredIds: ['auditor-actor'] }),
    ).toBe(null);
  });

  it('returns offenders + actionable message when memory is paired with code-author', () => {
    const r = checkLlmCompatibility({
      llm: 'memory',
      registeredIds: ['code-author'],
    });
    expect(r).not.toBe(null);
    expect(r!.offenders).toEqual(['code-author']);
    // Message names the offender, the safe alternative, and the
    // contradicting flag -- enough for an operator to fix without
    // reading source.
    expect(r!.message).toContain('code-author');
    expect(r!.message).toContain('--llm=claude-cli');
    expect(r!.message).toContain('host.llm');
  });

  it('lists every offender (forward-compat for future LLM-requiring sub-actors)', () => {
    // Today the canonical set is {code-author}; the gate must still
    // enumerate every member of LLM_REQUIRING_SUB_ACTORS that the
    // caller registered, in order, so adding a new sub-actor (e.g.
    // a future `deploy-actor` whose drafter calls host.llm) does
    // not silently bypass the gate when the first offender is
    // already present.
    expect(LLM_REQUIRING_SUB_ACTORS.length).toBeGreaterThanOrEqual(1);
    const r = checkLlmCompatibility({
      llm: 'memory',
      registeredIds: [...LLM_REQUIRING_SUB_ACTORS, 'unrelated-actor'],
    });
    expect(r!.offenders).toEqual([...LLM_REQUIRING_SUB_ACTORS]);
  });
});
