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
 *   - happy path: well-formed inputs produce the expected atom shape
 *   - id determinism: reuses mkPrObservationAtomId so two seeds for
 *     the same (owner, repo, number, head_sha[:12], minute) collapse
 *   - URL parsing edge cases: malformed prHtmlUrl is rejected with a
 *     descriptive Error (no silent malformed atom write)
 *   - empty / non-string commitSha is rejected
 *   - the seed passes the pr-observation-refresh filter contract
 *     (metadata.kind === 'pr-observation', plan_id present,
 *     pr_state non-terminal, pr ref well-formed)
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  mkPrObservationSeedAtom,
  parsePrHtmlUrl,
} from '../../../src/runtime/actor-message/pr-observation-seed.js';
import type { CodeAuthorExecutorSuccess } from '../../../src/runtime/actor-message/code-author-invoker.js';
import { runPlanObservationRefreshTick } from '../../../src/runtime/plans/pr-observation-refresh.js';
import type { Atom, AtomId, PlanState, PrincipalId, Time } from '../../../src/types.js';

const PRINCIPAL = 'code-author' as PrincipalId;
const PLAN_ID = 'plan-x';
const OBSERVED_AT = '2026-05-07T18:00:00.000Z' as Time;

function mkExecutorSuccess(overrides: Partial<CodeAuthorExecutorSuccess> = {}): CodeAuthorExecutorSuccess {
  return {
    kind: 'dispatched',
    prNumber: 42,
    prHtmlUrl: 'https://github.com/foo/bar/pull/42',
    commitSha: 'abc1234567890def0011223344556677889900aa',
    branchName: 'code-author/plan-x-deadbeef',
    totalCostUsd: 0.42,
    modelUsed: 'claude-opus-4-7',
    confidence: 0.86,
    touchedPaths: ['docs/framework.md'],
    ...overrides,
  };
}

describe('parsePrHtmlUrl', () => {
  it('parses a canonical github.com PR URL', () => {
    const r = parsePrHtmlUrl('https://github.com/foo/bar/pull/42');
    expect(r).toEqual({ owner: 'foo', repo: 'bar', number: 42 });
  });

  it('parses a real-world repo with hyphens and dots', () => {
    const r = parsePrHtmlUrl('https://github.com/stephengardner/layered-autonomous-governance/pull/344');
    expect(r).toEqual({
      owner: 'stephengardner',
      repo: 'layered-autonomous-governance',
      number: 344,
    });
  });

  it('handles trailing slash', () => {
    const r = parsePrHtmlUrl('https://github.com/foo/bar/pull/42/');
    expect(r).toEqual({ owner: 'foo', repo: 'bar', number: 42 });
  });

  it('throws on non-string input', () => {
    // @ts-expect-error -- testing runtime guard
    expect(() => parsePrHtmlUrl(undefined)).toThrow(/non-empty string/);
    // @ts-expect-error -- testing runtime guard
    expect(() => parsePrHtmlUrl(123)).toThrow(/non-empty string/);
    expect(() => parsePrHtmlUrl('')).toThrow(/non-empty string/);
  });

  it('throws on missing scheme', () => {
    expect(() => parsePrHtmlUrl('github.com/foo/bar/pull/42')).toThrow(/not a valid URL/);
  });

  it('throws on non-github host', () => {
    expect(() => parsePrHtmlUrl('https://gitlab.com/foo/bar/pull/42')).toThrow(/host must be github\.com/);
    expect(() => parsePrHtmlUrl('https://api.github.com/foo/bar/pull/42')).toThrow(/host must be github\.com/);
  });

  it('throws when the pull segment is missing', () => {
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/issues/42')).toThrow(/segment 3 must be 'pull'/);
  });

  it('throws when the path is too short', () => {
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar')).toThrow(/too few segments/);
  });

  it('throws when the number segment is not a positive integer', () => {
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/pull/abc')).toThrow(/not a positive integer/);
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/pull/1.5')).toThrow(/not a positive integer/);
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/pull/0')).toThrow(/not a positive integer/);
    expect(() => parsePrHtmlUrl('https://github.com/foo/bar/pull/-3')).toThrow(/not a positive integer/);
  });

  it('throws when owner or repo is empty', () => {
    // Slashes that produce empty segments are filtered, so multiple
    // slashes generate "too few segments". Single empty segments need
    // a different shape, which URL parsing actually normalizes away.
    // The defensive checks remain in case an upstream caller passes
    // a URL constructor that does not normalize.
    expect(() => parsePrHtmlUrl('https://github.com//bar/pull/42')).toThrow(/too few segments|owner segment is empty/);
  });
});

describe('mkPrObservationSeedAtom', () => {
  it('produces an atom with metadata.kind=pr-observation (the discriminator pr-observation-refresh filters on)', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
    });
    expect(atom.type).toBe('observation');
    expect(atom.layer).toBe('L1');
    expect(atom.metadata['kind']).toBe('pr-observation');
  });

  it('parses pr ref out of the prHtmlUrl into metadata.pr', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess({
        prHtmlUrl: 'https://github.com/foo/bar/pull/42',
      }),
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata['pr']).toEqual({ owner: 'foo', repo: 'bar', number: 42 });
  });

  it('stamps confidence=0.7 for a synthesized seed (we did not query GitHub)', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
    });
    expect(atom.confidence).toBe(0.7);
  });

  it('marks partial=true and partial_surfaces=[all]', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata['partial']).toBe(true);
    expect(atom.metadata['partial_surfaces']).toEqual(['all']);
  });

  it('chains provenance.derived_from to the plan id', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
    });
    expect(atom.provenance.derived_from).toEqual([PLAN_ID]);
  });

  it('records pr_state=OPEN, head_sha, observed_at', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess({ commitSha: 'feedfacecafe1234567890abcdef0011223344556677889900' }),
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
      executorResult: mkExecutorSuccess(),
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
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata['mergeable']).toBeNull();
    expect(atom.metadata['merge_state_status']).toBeNull();
  });

  it('omits pr_title (would force a defensive type guard for null on consumers)', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
    });
    expect(atom.metadata).not.toHaveProperty('pr_title');
  });

  it('id reuses mkPrObservationAtomId (matches pr-landing builder shape)', () => {
    // Two seeds for the same (owner, repo, number, head_sha[:12],
    // minute) collapse to the same id. This means a pr-landing
    // observe-only run minutes later that produces a hydrated
    // observation under the same id supersedes this seed naturally.
    const atomA = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
    });
    expect(atomA.id).toMatch(/^pr-observation-foo-bar-42-abc123456789-/);
  });

  it('throws on missing /pull/ in URL (no silent malformed atom)', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess({ prHtmlUrl: 'https://github.com/foo/bar/issues/42' }),
      observedAt: OBSERVED_AT,
    })).toThrow(/segment 3 must be 'pull'/);
  });

  it('throws on non-integer pr number', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess({ prHtmlUrl: 'https://github.com/foo/bar/pull/abc' }),
      observedAt: OBSERVED_AT,
    })).toThrow(/not a positive integer/);
  });

  it('throws on missing scheme', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess({ prHtmlUrl: 'github.com/foo/bar/pull/42' }),
      observedAt: OBSERVED_AT,
    })).toThrow(/not a valid URL/);
  });

  it('throws on empty commitSha', () => {
    expect(() => mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess({ commitSha: '' }),
      observedAt: OBSERVED_AT,
    })).toThrow(/commitSha must be a non-empty string/);
  });

  it('forwards the correlation id into provenance.source.session_id when provided', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
      correlationId: 'corr-abc',
    });
    expect(atom.provenance.source['session_id']).toBe('corr-abc');
  });

  it('omits session_id when correlationId is absent', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
      observedAt: OBSERVED_AT,
    });
    expect(atom.provenance.source).not.toHaveProperty('session_id');
  });

  it('content prose names the synthesized nature so a console reader sees it', () => {
    const atom = mkPrObservationSeedAtom({
      principal: PRINCIPAL,
      planId: PLAN_ID,
      executorResult: mkExecutorSuccess(),
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
      executorResult: mkExecutorSuccess({
        prHtmlUrl: 'https://github.com/foo/bar/pull/77',
      }),
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
      executorResult: mkExecutorSuccess(),
      observedAt,
    });
    await host.atoms.put(seed);

    const refresher = { async refresh() {} };
    const r = await runPlanObservationRefreshTick(host, refresher, { now });
    expect(r.refreshed).toBe(0);
    expect(r.skipped['fresh']).toBe(1);
  });
});
