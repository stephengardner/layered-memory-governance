/**
 * Tests for the pr-observation atom builders used by
 * `run-pr-landing.mjs --observe-only`.
 *
 * Spec (canon: `arch-pr-state-observation-via-actor-only`):
 *   - atom id keyed deterministically on head SHA (first 12 chars)
 *   - type 'observation' + metadata.kind 'pr-observation' (we do NOT
 *     widen the AtomType union)
 *   - layer L1 (extracted)
 *   - principal_id reflects the observing actor
 *   - derived_from chains to prior observation when present
 *   - confidence drops to 0.7 when the composite read was partial
 *   - failed observations use metadata.kind 'pr-observation-failed'
 */

import { describe, expect, it } from 'vitest';
import {
  mkPrObservationAtom,
  mkPrObservationAtomId,
  mkPrObservationFailedAtom,
  renderPrObservationBody,
} from '../../src/actors/pr-landing/pr-observation.js';
import type {
  PrIdentifier,
  PrReviewStatus,
} from '../../src/actors/pr-review/adapter.js';
import type { AtomId, Principal, PrincipalId, Time } from '../../src/types.js';

function mkPrincipal(id = 'pr-landing-agent'): Principal {
  return {
    id: id as PrincipalId,
    name: 'Test Principal',
    role: 'agent',
    permitted_scopes: {
      read: ['project'],
      write: ['project'],
    },
    permitted_layers: {
      read: ['L0', 'L1', 'L2', 'L3'],
      write: ['L0', 'L1'],
    },
    goals: [],
    constraints: [],
    active: true,
    compromised_at: null,
    signed_by: 'claude-agent' as PrincipalId,
    created_at: '2026-04-21T00:00:00.000Z' as Time,
  };
}

function mkStatus(overrides: Partial<PrReviewStatus> = {}): PrReviewStatus {
  const pr: PrIdentifier = { owner: 'o', repo: 'r', number: 42 };
  return {
    pr,
    mergeable: true,
    mergeStateStatus: 'CLEAN',
    lineComments: [],
    bodyNits: [],
    submittedReviews: [],
    checkRuns: [],
    legacyStatuses: [],
    partial: false,
    partialSurfaces: [],
    ...overrides,
  };
}

describe('mkPrObservationAtomId', () => {
  it('is deterministic on (owner, repo, number, headSha-prefix-12)', () => {
    const a = mkPrObservationAtomId('o', 'r', 42, 'abcdef1234567890abcdef');
    const b = mkPrObservationAtomId('o', 'r', 42, 'abcdef1234567890feedface');
    // Same first 12 chars of SHA -> same id. This is a deliberate
    // collision on SHA prefix: if Git ever produces two distinct
    // SHAs with the same 12-char prefix on the same PR, we want the
    // second observation to overwrite the first (same git state).
    expect(a).toBe(b);
    expect(a).toBe('pr-observation-o-r-42-abcdef123456');
  });

  it('varies when any key component varies', () => {
    const base = mkPrObservationAtomId('o', 'r', 42, 'abc123def456');
    expect(mkPrObservationAtomId('o2', 'r', 42, 'abc123def456')).not.toBe(base);
    expect(mkPrObservationAtomId('o', 'r2', 42, 'abc123def456')).not.toBe(base);
    expect(mkPrObservationAtomId('o', 'r', 43, 'abc123def456')).not.toBe(base);
    expect(mkPrObservationAtomId('o', 'r', 42, 'zzz111aaa222')).not.toBe(base);
  });
});

describe('mkPrObservationAtom', () => {
  const base = {
    atomId: 'pr-observation-o-r-42-abc123def456' as AtomId,
    principal: mkPrincipal(),
    owner: 'o',
    repo: 'r',
    number: 42,
    headSha: 'abc123def456aaaa',
    body: 'rendered body',
    observedAt: '2026-04-21T04:00:00.000Z' as Time,
  };

  it('writes type observation with metadata.kind pr-observation (no AtomType widening)', () => {
    const atom = mkPrObservationAtom({
      ...base,
      status: mkStatus(),
    });
    // The discriminator is metadata.kind, not a new AtomType.
    // Framework directives (dev-substrate-not-prescription) forbid
    // widening the core union for one instance.
    expect(atom.type).toBe('observation');
    expect(atom.metadata?.kind).toBe('pr-observation');
    expect(atom.layer).toBe('L1');
  });

  it('stamps principal_id from the observing actor', () => {
    const atom = mkPrObservationAtom({
      ...base,
      status: mkStatus(),
    });
    expect(atom.principal_id).toBe('pr-landing-agent');
    expect(atom.provenance.source?.agent_id).toBe('pr-landing-agent');
    expect(atom.provenance.source?.tool).toBe('run-pr-landing-observe-only');
  });

  it('chains derived_from to a prior observation when present', () => {
    const atom = mkPrObservationAtom({
      ...base,
      status: mkStatus(),
      priorId: 'pr-observation-o-r-42-prior0000000',
    });
    expect(atom.provenance.derived_from).toEqual(['pr-observation-o-r-42-prior0000000']);
  });

  it('empty derived_from when no prior observation', () => {
    const atom = mkPrObservationAtom({
      ...base,
      status: mkStatus(),
      priorId: null,
    });
    expect(atom.provenance.derived_from).toEqual([]);
  });

  it('drops confidence to 0.7 when the composite read was partial', () => {
    const atom = mkPrObservationAtom({
      ...base,
      status: mkStatus({ partial: true, partialSurfaces: ['check-runs: 500'] }),
    });
    expect(atom.confidence).toBe(0.7);
    const md = atom.metadata as Record<string, unknown>;
    expect(md.partial).toBe(true);
    expect(md.partial_surfaces).toEqual(['check-runs: 500']);
  });

  it('surfaces the composite snapshot shape in metadata for consumers', () => {
    const atom = mkPrObservationAtom({
      ...base,
      status: mkStatus({
        mergeable: true,
        mergeStateStatus: 'CLEAN',
        submittedReviews: [
          { author: 'coderabbitai', state: 'COMMENTED', submittedAt: '2026-04-21T03:00:00Z' },
        ],
        checkRuns: [
          { name: 'Node 22 on ubuntu-latest', status: 'completed', conclusion: 'success' },
        ],
      }),
    });
    const md = atom.metadata as Record<string, unknown>;
    expect(md.mergeable).toBe(true);
    expect(md.merge_state_status).toBe('CLEAN');
    const counts = md.counts as Record<string, number>;
    expect(counts.submitted_reviews).toBe(1);
    expect(counts.check_runs).toBe(1);
    expect(counts.line_comments).toBe(0);
  });

  it('optional origin records into provenance.source.session_id', () => {
    const withOrigin = mkPrObservationAtom({
      ...base,
      status: mkStatus(),
      origin: 'github-action',
    });
    expect(withOrigin.provenance.source?.session_id).toBe('github-action');
    const withoutOrigin = mkPrObservationAtom({
      ...base,
      status: mkStatus(),
    });
    expect(withoutOrigin.provenance.source?.session_id).toBeUndefined();
  });
});

describe('mkPrObservationFailedAtom', () => {
  it('writes metadata.kind pr-observation-failed with the reason', () => {
    const atom = mkPrObservationFailedAtom({
      atomId: 'pr-observation-failed-o-r-42-1' as AtomId,
      principal: mkPrincipal(),
      owner: 'o',
      repo: 'r',
      number: 42,
      reason: 'network timeout',
      observedAt: '2026-04-21T04:00:00.000Z' as Time,
    });
    expect(atom.type).toBe('observation');
    expect(atom.layer).toBe('L1');
    expect((atom.metadata as Record<string, unknown>).kind).toBe('pr-observation-failed');
    expect((atom.metadata as Record<string, unknown>).reason).toBe('network timeout');
    expect(atom.content).toContain('network timeout');
    expect(atom.content).toContain('o/r#42');
  });
});

describe('renderPrObservationBody', () => {
  it('renders a self-explanatory summary with every surface', () => {
    const body = renderPrObservationBody({
      owner: 'o',
      repo: 'r',
      number: 42,
      status: mkStatus({
        mergeable: true,
        mergeStateStatus: 'CLEAN',
        submittedReviews: [
          { author: 'coderabbitai', state: 'COMMENTED', submittedAt: '2026-04-21T03:00:00Z' },
        ],
        checkRuns: [
          { name: 'CI', status: 'completed', conclusion: 'success' },
        ],
        // Cover BOTH lineComments and bodyNits in the every-surface
        // test so a regression that drops per-item rendering gets
        // caught here, not just in the dedicated per-item test.
        lineComments: [
          {
            id: 'lc1',
            author: 'coderabbitai',
            body: 'Fix the null handling here',
            path: 'src/example.ts',
            line: 12,
            createdAt: '2026-04-21T03:00:00Z',
            resolved: false,
          },
        ],
        bodyNits: [
          {
            id: 'bn1',
            author: 'coderabbitai[bot]',
            body: 'Minor: prefer enum over string literal',
            path: 'src/enum.ts',
            line: 8,
            createdAt: '2026-04-21T03:00:00Z',
            resolved: false,
            kind: 'body-nit',
          },
        ],
      }),
      headSha: 'abc123def456',
      observedAt: '2026-04-21T04:00:00.000Z' as Time,
    });
    expect(body).toContain('pr-observation for o/r#42');
    expect(body).toContain('head_sha: `abc123def456`');
    expect(body).toContain('mergeable: true');
    expect(body).toContain('mergeStateStatus: `CLEAN`');
    expect(body).toContain('submitted reviews: 1');
    expect(body).toContain('coderabbitai COMMENTED at 2026-04-21T03:00:00Z');
    expect(body).toContain('check-runs: 1');
    expect(body).toContain('CI: success');
    // Per-item detail (not just counts) so pr-status atom-first path
    // stays actionable for readers.
    expect(body).toContain('unresolved line comments: 1');
    expect(body).toContain('src/example.ts:12');
    expect(body).toContain('Fix the null handling here');
    expect(body).toContain('body-scoped nits: 1');
    expect(body).toContain('src/enum.ts:8');
    expect(body).toContain('prefer enum over string literal');
    // Mechanism-level trailer (no deployment-specific canon ids in
    // src/ per the framework's mechanism-only rule).
    expect(body).toContain('Emitted by the PR observation runner');
  });

  it('renders per-item details for unresolved line comments and body-nits (not just counts)', () => {
    const body = renderPrObservationBody({
      owner: 'o',
      repo: 'r',
      number: 42,
      status: mkStatus({
        lineComments: [
          {
            id: 'c1',
            author: 'coderabbitai',
            body: '**Thread-safety issue in foo.ts**\n\nlong body...',
            createdAt: '2026-04-21T03:00:00Z',
            resolved: false,
            path: 'src/foo.ts',
            line: 42,
          },
        ],
        bodyNits: [
          {
            id: 'body-nit:99:src/bar.ts:7',
            author: 'coderabbitai[bot]',
            body: 'Minor wording suggestion.',
            createdAt: '2026-04-21T03:00:00Z',
            resolved: false,
            path: 'src/bar.ts',
            line: 7,
            kind: 'body-nit',
          },
        ],
      }),
      headSha: 'abc123def456',
      observedAt: '2026-04-21T04:00:00.000Z' as Time,
    });
    // Must include per-item details so the fresh-atom path in
    // pr-status.mjs can surface WHICH items are unresolved, not just
    // counts.
    expect(body).toMatch(/unresolved line comments: 1/);
    expect(body).toContain('src/foo.ts:42');
    expect(body).toContain('coderabbitai');
    expect(body).toContain('Thread-safety issue in foo.ts');
    expect(body).toMatch(/body-scoped nits: 1/);
    expect(body).toContain('src/bar.ts:7');
    expect(body).toContain('Minor wording suggestion.');
  });

  it('surfaces partial status with failed surfaces listed', () => {
    const body = renderPrObservationBody({
      owner: 'o',
      repo: 'r',
      number: 42,
      status: mkStatus({
        partial: true,
        partialSurfaces: ['check-runs: 500', 'legacy-statuses: 500'],
      }),
      headSha: 'abc123def456',
      observedAt: '2026-04-21T04:00:00.000Z' as Time,
    });
    expect(body).toMatch(/partial: 2 surfaces failed/);
    expect(body).toContain('check-runs: 500');
    expect(body).toContain('legacy-statuses: 500');
  });
});
