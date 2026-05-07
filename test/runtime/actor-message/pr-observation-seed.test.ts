/**
 * Unit tests for the pr-observation seed builder.
 *
 * Closes substrate gap #8 part 2: the code-author dispatch path emits
 * one atom of kind `code-author-invoked` and zero atoms of kind
 * `pr-observation`, leaving runPlanObservationRefreshTick blind to the
 * dispatched PR. The seed builder produces a synthesized observation
 * the refresh tick can find on its first scan after the freshness
 * window expires.
 *
 * Coverage:
 *   - happy path: structured pr ref + headSha produce expected atom
 *   - id determinism: reuses mkPrObservationAtomId so two seeds for
 *     the same (owner, repo, number, head_sha[:12], minute) collapse
 *   - argument-validation guards: empty owner/repo, non-integer
 *     number, empty headSha, empty planId
 *   - the seed passes the pr-observation-refresh filter contract
 *     (metadata.kind === 'pr-observation', plan_id present,
 *     pr_state non-terminal, pr ref well-formed)
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { mkPrObservationSeedAtom } from '../../../src/runtime/actor-message/pr-observation-seed.js';
import { runPlanObservationRefreshTick } from '../../../src/runtime/plans/pr-observation-refresh.js';
import type { Atom, AtomId, PlanState, PrincipalId, Time } from '../../../src/types.js';

const PRINCIPAL = 'code-author' as PrincipalId;
const PLAN_ID = 'plan-x';
const OBSERVED_AT = '2026-05-07T18:00:00.000Z' as Time;
const HEAD_SHA = 'abc1234567890def0011223344556677889900aa';

function mkPrRef(overrides: Partial<{ owner: string; repo: string; number: number }> = {}) {
  return {
    owner: 'foo',
    repo: 'bar',
    number: 42,
    ...overrides,
  };
}

describe('mkPrObservationSeedAtom', () => {
  it('produces an atom with metadata.kind=pr-observation (the discriminator pr-observation-refresh filters on)', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.type).toBe('observation');
    expect(atom.layer).toBe('L1');
    expect(atom.metadata['kind']).toBe('pr-observation');
  });

  it('writes the pr ref into metadata.pr', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: { owner: 'foo', repo: 'bar', number: 42 },
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata['pr']).toEqual({ owner: 'foo', repo: 'bar', number: 42 });
  });

  it('stamps confidence=0.7 for a synthesized seed (we did not query the forge)', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.confidence).toBe(0.7);
  });

  it('marks partial=true and partial_surfaces=[all]', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata['partial']).toBe(true);
    expect(atom.metadata['partial_surfaces']).toEqual(['all']);
  });

  it('chains provenance.derived_from to the plan id', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.provenance.derived_from).toEqual([PLAN_ID]);
  });

  it('records pr_state=OPEN, head_sha, observed_at', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: 'feedfacecafe1234567890abcdef0011223344556677889900',
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata['pr_state']).toBe('OPEN');
    expect(atom.metadata['head_sha']).toBe('feedfacecafe1234567890abcdef0011223344556677889900');
    expect(atom.metadata['observed_at']).toBe(OBSERVED_AT);
  });

  it('writes empty counts so consumers do not need a defensive null check', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata['counts']).toEqual({
      line_comments: 0,
      body_nits: 0,
      submitted_reviews: 0,
      check_runs: 0,
      legacy_statuses: 0,
    });
  });

  it('sets mergeable=null and merge_state_status=null (no live query)', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata['mergeable']).toBeNull();
    expect(atom.metadata['merge_state_status']).toBeNull();
  });

  it('omits pr_title (would force a defensive type guard for null on consumers)', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata).not.toHaveProperty('pr_title');
  });

  it('id reuses mkPrObservationAtomId (matches pr-landing builder shape)', () => {
    // Two seeds for the same (owner, repo, number, head_sha[:12],
    // minute) collapse to the same id. This means a pr-landing
    // observe-only run minutes later that produces a hydrated
    // observation under the same id supersedes this seed naturally.
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.id).toMatch(/^pr-observation-foo-bar-42-abc123456789-/);
  });

  it('throws on empty owner', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: { owner: '', repo: 'bar', number: 42 },
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    })).toThrow(/pr\.owner must be a non-empty string/);
  });

  it('throws on empty repo', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: { owner: 'foo', repo: '', number: 42 },
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    })).toThrow(/pr\.repo must be a non-empty string/);
  });

  it('throws on non-integer number', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: { owner: 'foo', repo: 'bar', number: 1.5 },
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    })).toThrow(/pr\.number must be a positive integer/);
  });

  it('throws on zero or negative number', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: { owner: 'foo', repo: 'bar', number: 0 },
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    })).toThrow(/pr\.number must be a positive integer/);
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: { owner: 'foo', repo: 'bar', number: -3 },
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    })).toThrow(/pr\.number must be a positive integer/);
  });

  it('throws on empty headSha', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: '',
      observedAt: OBSERVED_AT,
    })).toThrow(/headSha must be a non-empty string/);
  });

  it('throws on empty planId', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: '',
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    })).toThrow(/planId must be a non-empty string/);
  });

  it('forwards the correlation id into provenance.source.session_id when provided', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
      correlationId: 'corr-abc',
    });
    expect(atom.provenance.source['session_id']).toBe('corr-abc');
  });

  it('omits session_id when correlationId is absent', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.provenance.source).not.toHaveProperty('session_id');
  });

  it('content prose names the synthesized nature so a console reader sees it', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      pr: mkPrRef(),
      headSha: HEAD_SHA,
      observedAt: OBSERVED_AT,
    });
    expect(atom.content).toMatch(/synthesized at code-author dispatch/);
    expect(atom.content).toMatch(/refresh tick will hydrate/);
  });
});

describe('mkPrObservationSeedAtom -> runPlanObservationRefreshTick (contract integration)', () => {
  // The whole point of the seed is that the refresh tick can find it.
  // This integration test wires both modules together: write a seed
  // for an executing plan with the seed's observed_at older than the
  // freshness threshold, run the tick, and confirm the refresher is
  // invoked with the expected (pr, plan_id).

  function planFor(id: string, state: PlanState): Atom {
    const T_OLD = '2026-05-01T00:00:00.000Z' as Time;
    return {
      schema_version: 1,
      id: id as AtomId,
      content: 'plan',
      type: 'plan',
      layer: 'L1',
      provenance: {
        kind: 'agent-observed',
        source: { agent_id: 'cto-actor' },
        derived_from: [],
      },
      confidence: 0.9,
      created_at: T_OLD,
      last_reinforced_at: T_OLD,
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
      principal_id: 'cto-actor' as PrincipalId,
      taint: 'clean',
      plan_state: state,
      metadata: {},
    };
  }

  it('a seed with stale observed_at + executing plan triggers the refresher', async () => {
    const host = createMemoryHost();
    // Plan in executing state.
    await host.atoms.put(planFor('plan-test-seed', 'executing'));

    // Seed observed_at is 1 hour ago; freshness window is 5 minutes.
    const observedAt = '2026-05-07T17:00:00.000Z' as Time;
    const now = () => '2026-05-07T18:00:00.000Z';

    const seed = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: 'plan-test-seed',
      pr: { owner: 'foo', repo: 'bar', number: 77 },
      headSha: HEAD_SHA,
      observedAt,
    });
    await host.atoms.put(seed);

    const refresherCalls: Array<{ pr: unknown; plan_id: string }> = [];
    const refresher = {
      async refresh(args: { pr: unknown; plan_id: string }) {
        refresherCalls.push(args);
      },
    };

    const r = await runPlanObservationRefreshTick(host, refresher, { now });
    expect(r.refreshed).toBe(1);
    expect(refresherCalls).toEqual([
      { pr: { owner: 'foo', repo: 'bar', number: 77 }, plan_id: 'plan-test-seed' },
    ]);
  });

  it('a fresh seed (within freshness window) is not refreshed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(planFor('plan-fresh', 'executing'));

    // Seed observed_at and now are within the 5-minute freshness window.
    const observedAt = '2026-05-07T18:00:00.000Z' as Time;
    const now = () => '2026-05-07T18:01:00.000Z';

    const seed = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: 'plan-fresh',
      pr: { owner: 'foo', repo: 'bar', number: 1 },
      headSha: HEAD_SHA,
      observedAt,
    });
    await host.atoms.put(seed);

    const refresher = { async refresh() {} };
    const r = await runPlanObservationRefreshTick(host, refresher, { now });
    expect(r.refreshed).toBe(0);
    expect(r.skipped['fresh']).toBe(1);
  });
});
