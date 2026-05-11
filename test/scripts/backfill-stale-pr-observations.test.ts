/**
 * Unit tests for the backfill-stale-pr-observations heal script.
 *
 * The script's main() invokes the host + spawns gh-as.mjs, so the
 * tests cover the EXPORTED PURE HELPERS that drive every branch of
 * the classification + heal-atom-construction logic. The full
 * integration that actually spawns gh-as is exercised by the dogfeed
 * validation step (run with --apply on the live store).
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STALENESS_MS,
  buildHealAtom,
  parseArgs,
  resolveStalenessMs,
} from '../../scripts/backfill-stale-pr-observations.mjs';

describe('parseArgs', () => {
  it('returns sensible defaults for empty argv', () => {
    const r = parseArgs([]);
    expect(r.apply).toBe(false);
    expect(r.rootDir).toBeUndefined();
    expect(r.stalenessMsOverride).toBeUndefined();
    expect(r.prTimeoutMs).toBe(10_000);
    expect(r.bot).toBe('lag-ceo');
  });

  it('honors --apply flag', () => {
    expect(parseArgs(['--apply']).apply).toBe(true);
  });

  it('honors --root path argument', () => {
    expect(parseArgs(['--root', '/tmp/lag']).rootDir).toBe('/tmp/lag');
  });

  it('honors --staleness-ms when value is a positive finite number', () => {
    expect(parseArgs(['--staleness-ms', '60000']).stalenessMsOverride).toBe(60_000);
  });

  it('drops --staleness-ms when value is not a positive finite number', () => {
    // Malformed values fall through to undefined so resolveStalenessMs
    // consults canon. Negative / zero / non-numeric values all degrade
    // to the canon-or-default path; this guards against accidental
    // disable via fat-finger.
    expect(parseArgs(['--staleness-ms', '0']).stalenessMsOverride).toBeUndefined();
    expect(parseArgs(['--staleness-ms', '-1']).stalenessMsOverride).toBeUndefined();
    expect(parseArgs(['--staleness-ms', 'abc']).stalenessMsOverride).toBeUndefined();
  });

  it('honors --pr-timeout-ms with a positive value', () => {
    expect(parseArgs(['--pr-timeout-ms', '5000']).prTimeoutMs).toBe(5_000);
    // Malformed timeout falls back to the default.
    expect(parseArgs(['--pr-timeout-ms', 'nope']).prTimeoutMs).toBe(10_000);
  });

  it('honors --bot for the gh-as identity', () => {
    expect(parseArgs(['--bot', 'lag-pr-landing']).bot).toBe('lag-pr-landing');
  });
});

describe('resolveStalenessMs', () => {
  it('returns DEFAULT_STALENESS_MS when the atom array is empty', () => {
    expect(resolveStalenessMs([], undefined)).toBe(DEFAULT_STALENESS_MS);
  });

  it('honors the override when supplied and positive-finite', () => {
    expect(resolveStalenessMs([], 60_000)).toBe(60_000);
  });

  it('reads the configured value from a well-formed canon atom', () => {
    const policy = {
      type: 'directive',
      layer: 'L3',
      taint: 'clean',
      superseded_by: [],
      metadata: {
        policy: {
          subject: 'pr-observation-staleness-ms',
          staleness_ms: 1_800_000,
        },
      },
    };
    expect(resolveStalenessMs([policy], undefined)).toBe(1_800_000);
  });

  it('returns POSITIVE_INFINITY when canon value is the "Infinity" sentinel', () => {
    // Deployments running on a webhook-driven observation pipeline use
    // 'Infinity' to disable staleness detection. The synthesizer treats
    // this as "no observation is ever stale", restoring pre-staleness
    // semantics for those deployments. JSON cannot encode the literal
    // Infinity, so the canonical wire shape is the string.
    const policy = {
      type: 'directive',
      layer: 'L3',
      taint: 'clean',
      superseded_by: [],
      metadata: {
        policy: { subject: 'pr-observation-staleness-ms', staleness_ms: 'Infinity' },
      },
    };
    expect(resolveStalenessMs([policy], undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it('falls through to default when canon value is malformed', () => {
    const policy = {
      type: 'directive',
      layer: 'L3',
      taint: 'clean',
      superseded_by: [],
      metadata: { policy: { subject: 'pr-observation-staleness-ms', staleness_ms: -5 } },
    };
    expect(resolveStalenessMs([policy], undefined)).toBe(DEFAULT_STALENESS_MS);
  });

  it('ignores non-L3 directives with the same subject', () => {
    const policy = {
      type: 'directive',
      layer: 'L0',
      taint: 'clean',
      superseded_by: [],
      metadata: { policy: { subject: 'pr-observation-staleness-ms', staleness_ms: 60_000 } },
    };
    expect(resolveStalenessMs([policy], undefined)).toBe(DEFAULT_STALENESS_MS);
  });

  it('ignores tainted directives', () => {
    const policy = {
      type: 'directive',
      layer: 'L3',
      taint: 'tainted',
      superseded_by: [],
      metadata: { policy: { subject: 'pr-observation-staleness-ms', staleness_ms: 60_000 } },
    };
    expect(resolveStalenessMs([policy], undefined)).toBe(DEFAULT_STALENESS_MS);
  });

  it('ignores superseded directives', () => {
    const policy = {
      type: 'directive',
      layer: 'L3',
      taint: 'clean',
      superseded_by: ['some-other-atom'],
      metadata: { policy: { subject: 'pr-observation-staleness-ms', staleness_ms: 60_000 } },
    };
    expect(resolveStalenessMs([policy], undefined)).toBe(DEFAULT_STALENESS_MS);
  });
});

describe('buildHealAtom', () => {
  const stale = {
    id: 'pr-observation-foo-bar-42-deadbeefcafe-202604260800',
    created_at: '2026-04-26T08:00:00.000Z',
    metadata: {
      kind: 'pr-observation',
      pr: { owner: 'foo', repo: 'bar', number: 42 },
      pr_state: 'OPEN',
      observed_at: '2026-04-26T08:00:00.000Z',
      plan_id: 'plan-test-1',
      head_sha: 'deadbeefcafe',
    },
  };

  it('constructs a heal atom that supersedes the stale row', () => {
    const heal = buildHealAtom({
      stale,
      live: {
        state: 'MERGED',
        mergedAt: '2026-04-27T10:00:00Z',
        mergeCommitSha: 'mergesha999',
        headSha: 'deadbeefcafe',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.type).toBe('observation');
    expect(heal.metadata.kind).toBe('pr-observation');
    expect(heal.metadata.pr_state).toBe('MERGED');
    expect(heal.metadata.pr).toEqual({ owner: 'foo', repo: 'bar', number: 42 });
    expect(heal.metadata.merged_at).toBe('2026-04-27T10:00:00Z');
    expect(heal.metadata.merge_commit_sha).toBe('mergesha999');
    expect(heal.supersedes).toEqual([stale.id]);
    // The atom-id pattern includes owner/repo/number/headSha-prefix/minute.
    expect(heal.id).toContain('foo-bar-42');
  });

  it('chains derived_from through the stale atom AND the plan id', () => {
    const heal = buildHealAtom({
      stale,
      live: {
        state: 'CLOSED',
        mergedAt: null,
        mergeCommitSha: null,
        headSha: 'deadbeefcafe',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.provenance.derived_from).toContain(stale.id);
    expect(heal.provenance.derived_from).toContain('plan-test-1');
  });

  it('preserves the plan_id in metadata when present', () => {
    const heal = buildHealAtom({
      stale,
      live: {
        state: 'MERGED',
        mergedAt: '2026-04-27T10:00:00Z',
        mergeCommitSha: 'sha',
        headSha: 'sha',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.metadata.plan_id).toBe('plan-test-1');
  });

  it('omits plan_id from metadata when the stale atom had none', () => {
    // Partial-chain: a stale observation with no plan_id (legacy /
    // malformed) still heals because the backfill SHOULD update the
    // pr_state regardless. The heal atom omits plan_id rather than
    // synthesizing one.
    const stalePartial = {
      id: 'pr-observation-foo-bar-42-deadbeef-202604260800',
      created_at: '2026-04-26T08:00:00.000Z',
      metadata: {
        kind: 'pr-observation',
        pr: { owner: 'foo', repo: 'bar', number: 42 },
        pr_state: 'OPEN',
        observed_at: '2026-04-26T08:00:00.000Z',
        head_sha: 'deadbeef',
      },
    };
    const heal = buildHealAtom({
      stale: stalePartial,
      live: {
        state: 'MERGED',
        mergedAt: '2026-04-27T10:00:00Z',
        mergeCommitSha: 'sha',
        headSha: 'sha',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.metadata.plan_id).toBeUndefined();
  });

  it('writes the backfill audit envelope in metadata', () => {
    // The backfill envelope captures (a) why this atom exists and
    // (b) which atom it superseded so a future operator + the
    // canon-audit chain see the trail clearly.
    const heal = buildHealAtom({
      stale,
      live: {
        state: 'MERGED',
        mergedAt: '2026-04-27T10:00:00Z',
        mergeCommitSha: 'sha',
        headSha: 'sha',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.metadata.backfill).toBeTruthy();
    expect(heal.metadata.backfill.reason).toBe(
      'staleness-window-exceeded-pr-terminal-on-github',
    );
    expect(heal.metadata.backfill.superseded_atom_id).toBe(stale.id);
    expect(heal.metadata.backfill.backfilled_at).toBe('2026-05-11T19:00:00.000Z');
  });

  it('flags partial=true with partial_surfaces=[all] because gh pr view does not hydrate the review tree', () => {
    // gh pr view --json state,mergedAt covers the pr_state but NOT
    // counts (reviews / check-runs / line comments). The heal atom
    // must mark itself partial so a future hydrating observation can
    // supersede it cleanly without confusing downstream consumers.
    const heal = buildHealAtom({
      stale,
      live: {
        state: 'CLOSED',
        mergedAt: null,
        mergeCommitSha: null,
        headSha: 'deadbeefcafe',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.metadata.partial).toBe(true);
    expect(heal.metadata.partial_surfaces).toEqual(['all']);
  });

  it('routes principal_id through pr-landing-agent to match the existing pr-observation taxonomy', () => {
    // Existing pr-observation atoms (seed builder + landing builder)
    // all use pr-landing-agent as their principal_id. The heal atom
    // does the same so a principal-keyed audit query sees the heal
    // alongside the existing chain.
    const heal = buildHealAtom({
      stale,
      live: {
        state: 'MERGED',
        mergedAt: '2026-04-27T10:00:00Z',
        mergeCommitSha: 'sha',
        headSha: 'sha',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.principal_id).toBe('pr-landing-agent');
  });

  it('handles missing live.headSha by falling back to the stale head_sha', () => {
    // gh pr view returns headRefOid for the PR head; when absent the
    // stale atom's head_sha is the next best option so the atom-id
    // generator still produces a stable bucket.
    const heal = buildHealAtom({
      stale,
      live: {
        state: 'MERGED',
        mergedAt: '2026-04-27T10:00:00Z',
        mergeCommitSha: 'sha',
        headSha: '',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.metadata.head_sha).toBe('deadbeefcafe');
  });

  it('handles missing live.headSha AND missing stale head_sha by falling back to "unknown"', () => {
    const noHeadStale = {
      id: 'pr-observation-foo-bar-42-unknown-202604260800',
      created_at: '2026-04-26T08:00:00.000Z',
      metadata: {
        kind: 'pr-observation',
        pr: { owner: 'foo', repo: 'bar', number: 42 },
        pr_state: 'OPEN',
        observed_at: '2026-04-26T08:00:00.000Z',
      },
    };
    const heal = buildHealAtom({
      stale: noHeadStale,
      live: {
        state: 'CLOSED',
        mergedAt: null,
        mergeCommitSha: null,
        headSha: '',
      },
      nowIso: '2026-05-11T19:00:00.000Z',
    });
    expect(heal.metadata.head_sha).toBe('unknown');
  });
});
