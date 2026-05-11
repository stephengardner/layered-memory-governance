/**
 * Tests for the claim-reaper LoopRunner pass wiring.
 *
 * Covers two surfaces:
 *
 *   - `readLoopPassClaimReaperFromCanon`: subject-discriminated canon
 *     reader returning `{enabled: boolean} | null`. Mirrors the contract
 *     of `readPipelineReaperTtlsFromCanon`: null on absence, warn +
 *     null on malformed payload, skip tainted / superseded atoms.
 *
 *   - `LoopRunner` pass wiring: the runner skips the claim-reaper pass
 *     when canon + option default to false (claimReaperReport === null),
 *     invokes `runClaimReaperTick` when canon enables it, and the
 *     pass's independent try/catch keeps a throw in the reaper from
 *     short-circuiting the rest of the tick.
 *
 * The runner tests `vi.mock` the claim-reaper module so the tests
 * exercise the wiring without seeding the full set of claim-reaper
 * canon policies (cadence + grace windows + recovery cap + budget
 * tier ladder). The reader contract is exercised independently above.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { readLoopPassClaimReaperFromCanon } from '../../../src/runtime/loop/loop-pass-claim-reaper.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

// Mock the claim-reaper module before importing LoopRunner so the
// runner's `runClaimReaperTick` reference binds to the stub. The
// vi.mock factory must be self-contained (no closure over outer
// variables) per vitest hoisting rules; tests interact with it via
// `vi.mocked(...)`.
vi.mock('../../../src/runtime/loop/claim-reaper.js', () => ({
  runClaimReaperTick: vi.fn(async () => ({
    detected: 0,
    recovered: 0,
    escalated: 0,
  })),
}));

// Imported AFTER vi.mock so the runner picks up the stubbed module.
// eslint-disable-next-line import/first
import { LoopRunner } from '../../../src/runtime/loop/runner.js';
// eslint-disable-next-line import/first
import { runClaimReaperTick } from '../../../src/runtime/loop/claim-reaper.js';

const NOW = '2026-05-11T12:00:00.000Z' as Time;
const principal = 'loop-test' as PrincipalId;

/**
 * Direct console.error replacement for capture-on-test. The vitest
 * config in this repo runs with `globals: false` and the
 * vi.spyOn(console, 'error') interception has been unreliable in
 * that mode; direct replacement works in both contexts. Mirrors the
 * shape of test/runtime/loop/pipeline-reaper-ttls.test.ts.
 */
function captureStderr(): {
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
  restore: () => void;
} {
  const original = console.error;
  const captured: unknown[][] = [];
  const replacement: typeof console.error = (...args: unknown[]): void => {
    captured.push(args);
  };
  console.error = replacement;
  return {
    calls: captured,
    restore: () => {
      console.error = original;
    },
  };
}

/**
 * Run readLoopPassClaimReaperFromCanon with stderr captured,
 * restoring the original console.error in a finally block so a
 * thrown reader does not leak the patched global into later tests.
 */
async function readWithCapturedStderr(
  host: ReturnType<typeof createMemoryHost>,
): Promise<{
  readonly result: Awaited<ReturnType<typeof readLoopPassClaimReaperFromCanon>>;
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
}> {
  const cap = captureStderr();
  try {
    const result = await readLoopPassClaimReaperFromCanon(host);
    return { result, calls: cap.calls };
  } finally {
    cap.restore();
  }
}

interface PolicyFields {
  readonly enabled?: unknown;
}

function policyAtom(id: string, fields: PolicyFields): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'loop-pass-claim-reaper policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'loop-pass-claim-reaper-default',
        ...fields,
      },
    },
  };
}

beforeEach(() => {
  vi.mocked(runClaimReaperTick).mockReset();
  vi.mocked(runClaimReaperTick).mockImplementation(async () => ({
    detected: 0,
    recovered: 0,
    escalated: 0,
  }));
});

afterEach(() => {
  vi.mocked(runClaimReaperTick).mockReset();
});

describe('readLoopPassClaimReaperFromCanon', () => {
  it('returns null when no canon atom exists', async () => {
    const host = createMemoryHost();
    expect(await readLoopPassClaimReaperFromCanon(host)).toBeNull();
  });

  it('returns {enabled:true} when policy atom is present and enabled', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-loop-pass-claim-reaper-default', { enabled: true }));
    expect(await readLoopPassClaimReaperFromCanon(host)).toEqual({ enabled: true });
  });

  it('returns null + warns when enabled field is a non-boolean (string)', async () => {
    const host = createMemoryHost();
    // The wire-format failure mode under test: an operator-typed
    // "true" string. Strict typing on the reader prevents the
    // coercion-flipping foot-gun documented in the reader doc.
    await host.atoms.put(policyAtom('pol-bad-enabled', { enabled: 'true' }));
    const { result, calls } = await readWithCapturedStderr(host);
    expect(result).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('malformed payload');
    expect(String(calls[0]?.[0])).toContain('enabled');
  });

  it('skips tainted atoms', async () => {
    const host = createMemoryHost();
    const atom = policyAtom('pol-tainted', { enabled: true });
    await host.atoms.put({ ...atom, taint: 'tainted' });
    expect(await readLoopPassClaimReaperFromCanon(host)).toBeNull();
  });

  it('skips superseded atoms', async () => {
    const host = createMemoryHost();
    const atom = policyAtom('pol-superseded', { enabled: true });
    await host.atoms.put({ ...atom, superseded_by: ['pol-newer' as AtomId] });
    expect(await readLoopPassClaimReaperFromCanon(host)).toBeNull();
  });
});

describe('LoopRunner claim-reaper pass wiring', () => {
  it('skips the claim-reaper pass when canon + option default to false', async () => {
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    expect(report.claimReaperReport).toBeNull();
    expect(vi.mocked(runClaimReaperTick)).not.toHaveBeenCalled();
  });

  it('invokes runClaimReaperTick when the canon policy enables the pass', async () => {
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    await host.atoms.put(policyAtom('pol-loop-pass-claim-reaper-default', { enabled: true }));
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    expect(report.claimReaperReport).not.toBeNull();
    expect(report.claimReaperReport).toEqual({
      detected: 0,
      recovered: 0,
      escalated: 0,
    });
    expect(vi.mocked(runClaimReaperTick)).toHaveBeenCalledTimes(1);
  });

  it('invokes runClaimReaperTick when the constructor option enables the pass', async () => {
    // Resolution chain: canon (absent) -> option (true) -> hardcoded
    // false. Tests the second rung of the chain so the CLI / env
    // override surface is exercised independently of canon.
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    const runner = new LoopRunner(host, {
      principalId: principal,
      runClaimReaperPass: true,
    });
    const report = await runner.tick();
    expect(report.claimReaperReport).not.toBeNull();
    expect(vi.mocked(runClaimReaperTick)).toHaveBeenCalledTimes(1);
  });

  it('does not fail the tick when the claim-reaper throws (independent try/catch)', async () => {
    // Independence guarantee: a throw inside `runClaimReaperTick`
    // surfaces in `report.errors` but does NOT cascade into the
    // following passes (decay, promotion, canon applier). Mirrors
    // the plan-reaper + pipeline-reaper best-effort cleanup
    // discipline in runner.ts.
    vi.mocked(runClaimReaperTick).mockImplementation(async () => {
      throw new Error('synthetic claim-reaper failure');
    });
    const host = createMemoryHost();
    host.clock.setTime(NOW);
    await host.atoms.put(policyAtom('pol-loop-pass-claim-reaper-default', { enabled: true }));
    const runner = new LoopRunner(host, { principalId: principal });
    const report = await runner.tick();
    expect(report.claimReaperReport).toBeNull();
    expect(report.errors.some((e) => e.startsWith('claim-reaper-pass:'))).toBe(true);
    // Tick still completed: other report fields are populated as if
    // the reaper had silent-skipped. tickNumber and finishedAt are
    // load-bearing signals that the tick finished rather than
    // halting at the reaper throw.
    expect(report.tickNumber).toBe(1);
    expect(report.finishedAt).not.toBe('');
  });
});
