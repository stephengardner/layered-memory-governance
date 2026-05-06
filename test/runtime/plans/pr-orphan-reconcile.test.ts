/**
 * Tests for the PR-orphan reconciler tick.
 *
 * Covers the design matrix:
 *   - PR with no active claim AND stale activity -> orphan-by-no-claim
 *   - PR with no active claim AND fresh activity -> NOT orphan
 *   - PR with active+expired claim -> orphan-by-claim-expired
 *   - PR with active claim + claimant inactive + stale PR activity ->
 *     orphan-by-claimer-inactive
 *   - PR with active claim + claimant active -> NOT orphan
 *   - Idempotence (second tick within same cadence window: skip)
 *   - Per-tick dispatch budget (rate-limited orphan still atom-emitted
 *     but no dispatch)
 *   - Dispatcher failure recorded on orphan atom
 *   - Regression for the actual #323 case: PR open + CR review + sub-
 *     agent terminate, reconciler detects orphan within one cadence
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import { buildPrDriverClaim } from '../../../src/runtime/plans/pr-driver-ledger.js';
import {
  runPrOrphanReconcileTick,
  makeOrphanDetectedId,
  readPrOrphanThresholdMs,
  DEFAULT_ORPHAN_THRESHOLD_MS,
  type ClaimantActivityScanner,
  type OpenPrSnapshot,
  type OpenPrSource,
  type OrphanPrDispatcher,
  type OrphanReason,
} from '../../../src/runtime/plans/pr-orphan-reconcile.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-06T01:00:00.000Z' as Time;
const NOW_MS = Date.parse(NOW);
const PR = { owner: 'lag-org', repo: 'memory-governance', number: 323 };

function policyAtom(id: string, value: unknown): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'policy',
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
      policy: { subject: 'pr-orphan-reconcile-threshold-ms', threshold_ms: value },
    },
  };
}

class StaticOpenPrSource implements OpenPrSource {
  constructor(private readonly snapshots: ReadonlyArray<OpenPrSnapshot>) {}
  async list(): Promise<ReadonlyArray<OpenPrSnapshot>> {
    return this.snapshots;
  }
}

class CapturingDispatcher implements OrphanPrDispatcher {
  readonly calls: Array<{
    pr: { owner: string; repo: string; number: number };
    orphan_atom_id: AtomId;
    orphan_reason: OrphanReason;
  }> = [];
  constructor(private readonly throwOn: number = -1) {}
  async dispatch(args: {
    readonly pr: { readonly owner: string; readonly repo: string; readonly number: number };
    readonly orphan_atom_id: AtomId;
    readonly orphan_reason: OrphanReason;
    readonly prior_claim: unknown;
  }): Promise<void> {
    this.calls.push({
      pr: { ...args.pr },
      orphan_atom_id: args.orphan_atom_id,
      orphan_reason: args.orphan_reason,
    });
    if (this.calls.length === this.throwOn) {
      throw new Error('simulated transport failure');
    }
  }
}

class FixedActivityScanner implements ClaimantActivityScanner {
  constructor(private readonly latestMs: number | null) {}
  async latestActivityAt(): Promise<number | null> {
    return this.latestMs;
  }
}

const FRESH_THRESHOLD_MS = 5 * 60 * 1_000;

describe('readPrOrphanThresholdMs', () => {
  it('returns DEFAULT when no canon atom exists', async () => {
    const host = createMemoryHost();
    expect(await readPrOrphanThresholdMs(host)).toBe(DEFAULT_ORPHAN_THRESHOLD_MS);
  });

  it('returns the configured value when the canon atom is well-formed', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-pr-orphan-threshold', 60_000));
    expect(await readPrOrphanThresholdMs(host)).toBe(60_000);
  });

  it('falls back to default on malformed value', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-malformed', 'nope'));
    expect(await readPrOrphanThresholdMs(host)).toBe(DEFAULT_ORPHAN_THRESHOLD_MS);
  });

  it('ignores tainted canon atoms', async () => {
    const host = createMemoryHost();
    const a = policyAtom('pol-tainted', 60_000);
    await host.atoms.put({ ...a, taint: 'tainted' });
    expect(await readPrOrphanThresholdMs(host)).toBe(DEFAULT_ORPHAN_THRESHOLD_MS);
  });

  it('returns POSITIVE_INFINITY for the explicit "Infinity" sentinel', async () => {
    const host = createMemoryHost();
    await host.atoms.put(policyAtom('pol-disabled', 'Infinity'));
    expect(await readPrOrphanThresholdMs(host)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('runPrOrphanReconcileTick', () => {
  describe('orphan-by-no-claim', () => {
    it('PR with no claim AND stale activity is orphan -> dispatch fires', async () => {
      const host = createMemoryHost();
      const staleActivity = new Date(NOW_MS - 10 * 60_000).toISOString() as Time; // 10min ago
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: staleActivity },
      ]);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
      });
      expect(r.scanned).toBe(1);
      expect(r.orphansDetected).toBe(1);
      expect(r.dispatched).toBe(1);
      expect(dispatcher.calls).toHaveLength(1);
      expect(dispatcher.calls[0]!.orphan_reason).toBe('no-claim');
      // Atom was written with the deterministic id.
      const cadenceBucket = Math.floor(NOW_MS / (5 * 60_000));
      const expectedId = makeOrphanDetectedId(PR, cadenceBucket);
      const atom = await host.atoms.get(expectedId as AtomId);
      expect(atom).not.toBeNull();
      expect(atom?.type).toBe('pr-orphan-detected');
      expect(atom?.metadata['orphan_reason']).toBe('no-claim');
      expect(atom?.metadata['dispatch_attempted']).toBe(true);
    });

    it('PR with no claim AND fresh activity is NOT orphan', async () => {
      const host = createMemoryHost();
      const freshActivity = new Date(NOW_MS - 30_000).toISOString() as Time; // 30s ago
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: freshActivity },
      ]);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
      });
      expect(r.scanned).toBe(1);
      expect(r.orphansDetected).toBe(0);
      expect(r.dispatched).toBe(0);
      expect(r.skipped['no-claim-but-fresh']).toBe(1);
    });
  });

  describe('orphan-by-claim-expired', () => {
    it('PR with expired claim is orphan regardless of activity', async () => {
      const host = createMemoryHost();
      const claim = buildPrDriverClaim({
        pr: PR,
        principal_id: 'cto-actor',
        claimed_at: new Date(NOW_MS - 13 * 60 * 60_000).toISOString() as Time,
        // 12-hour default lifetime; claimed 13h ago = expired 1h ago.
      });
      await host.atoms.put(claim);
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: new Date(NOW_MS - 20_000).toISOString() as Time },
      ]);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
      });
      expect(r.orphansDetected).toBe(1);
      expect(r.dispatched).toBe(1);
      expect(dispatcher.calls[0]!.orphan_reason).toBe('claim-expired');
    });
  });

  describe('orphan-by-claimer-inactive', () => {
    it('claim active but claimant has no recent agent-turn AND PR stale -> orphan', async () => {
      const host = createMemoryHost();
      const claim = buildPrDriverClaim({
        pr: PR,
        principal_id: 'sub-agent-A',
        claimed_at: new Date(NOW_MS - 20 * 60_000).toISOString() as Time, // 20min ago
      });
      await host.atoms.put(claim);
      const staleActivity = new Date(NOW_MS - 10 * 60_000).toISOString() as Time;
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: staleActivity },
      ]);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
        claimantActivityScanner: new FixedActivityScanner(null),
      });
      expect(r.orphansDetected).toBe(1);
      expect(dispatcher.calls[0]!.orphan_reason).toBe('claimer-inactive');
    });

    it('claim active AND claimant recently active -> NOT orphan', async () => {
      const host = createMemoryHost();
      const claim = buildPrDriverClaim({
        pr: PR,
        principal_id: 'sub-agent-A',
        claimed_at: new Date(NOW_MS - 20 * 60_000).toISOString() as Time,
      });
      await host.atoms.put(claim);
      const staleActivity = new Date(NOW_MS - 10 * 60_000).toISOString() as Time;
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: staleActivity },
      ]);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
        claimantActivityScanner: new FixedActivityScanner(NOW_MS - 30_000),
      });
      expect(r.orphansDetected).toBe(0);
      expect(r.skipped['claim-active']).toBe(1);
    });

    it('claim active AND claimant inactive but PR fresh -> NOT orphan (race window protection)', async () => {
      // The PR just received CR feedback, so even though the claimant
      // sub-agent has been quiet, the orphan detector should not fire
      // until BOTH signals are stale. Otherwise a quick post-fix-push
      // window where the claimant is preparing the next response would
      // be misclassified.
      const host = createMemoryHost();
      const claim = buildPrDriverClaim({
        pr: PR,
        principal_id: 'sub-agent-A',
        claimed_at: new Date(NOW_MS - 20 * 60_000).toISOString() as Time,
      });
      await host.atoms.put(claim);
      const freshActivity = new Date(NOW_MS - 30_000).toISOString() as Time;
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: freshActivity },
      ]);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
        claimantActivityScanner: new FixedActivityScanner(null),
      });
      expect(r.orphansDetected).toBe(0);
      expect(r.skipped['claim-active']).toBe(1);
    });
  });

  describe('idempotence', () => {
    it('second tick within same cadence window does not re-detect', async () => {
      const host = createMemoryHost();
      const staleActivity = new Date(NOW_MS - 10 * 60_000).toISOString() as Time;
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: staleActivity },
      ]);
      const dispatcher = new CapturingDispatcher();
      const first = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
      });
      expect(first.orphansDetected).toBe(1);
      expect(first.dispatched).toBe(1);
      const second = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW, // same cadence bucket
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
      });
      expect(second.orphansDetected).toBe(0);
      expect(second.idempotentSkips).toBe(1);
      expect(dispatcher.calls).toHaveLength(1); // only the first
    });

    it('next cadence window re-detects (fresh bucket)', async () => {
      const host = createMemoryHost();
      const staleActivity = new Date(NOW_MS - 10 * 60_000).toISOString() as Time;
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: staleActivity },
      ]);
      const dispatcher = new CapturingDispatcher();
      await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
      });
      // Move the clock forward by one cadence bucket (default 5min).
      const nextWindow = new Date(NOW_MS + 6 * 60_000).toISOString() as Time;
      const r2 = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => nextWindow,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
      });
      expect(r2.orphansDetected).toBe(1);
      expect(dispatcher.calls).toHaveLength(2);
    });
  });

  describe('rate limiting', () => {
    it('only first N orphans get dispatched per tick; remaining counted as rate-limited', async () => {
      const host = createMemoryHost();
      const staleActivity = new Date(NOW_MS - 10 * 60_000).toISOString() as Time;
      const prs = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        pr: { owner: 'lag-org', repo: 'memory-governance', number: n },
        last_activity_at: staleActivity,
      }));
      const source = new StaticOpenPrSource(prs);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
        maxDispatchPerTickOverride: 3,
      });
      expect(r.scanned).toBe(7);
      expect(r.orphansDetected).toBe(7);
      expect(r.dispatched).toBe(3);
      expect(r.rateLimited).toBe(4);
      expect(dispatcher.calls).toHaveLength(3);
    });
  });

  describe('dispatcher failure', () => {
    it('records failure on the orphan atom and counts in failedDispatches', async () => {
      const host = createMemoryHost();
      const staleActivity = new Date(NOW_MS - 10 * 60_000).toISOString() as Time;
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: staleActivity },
      ]);
      const dispatcher = new CapturingDispatcher(1); // throw on first dispatch
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
      });
      expect(r.orphansDetected).toBe(1);
      expect(r.dispatched).toBe(0);
      expect(r.failedDispatches).toBe(1);
      const cadenceBucket = Math.floor(NOW_MS / (5 * 60_000));
      const orphanAtomId = makeOrphanDetectedId(PR, cadenceBucket) as AtomId;
      const atom = await host.atoms.get(orphanAtomId);
      expect(atom?.metadata['dispatch_attempted']).toBe(true);
      expect(atom?.metadata['dispatch_failed']).toBe(true);
      expect(atom?.metadata['dispatch_failure_reason']).toMatch(/simulated transport/);
    });
  });

  describe('regression: actual #323 case', () => {
    it('PR open + sub-agent terminate mid-CR-cycle => orphan within one cadence', async () => {
      // dogfeed-21 (`ae8a1f714d1084080`) opened PR #323 then terminated;
      // 41 minutes later the operator escalated. With the reconciler in
      // place, this scenario must produce a fresh-driver dispatch
      // within ONE cadence (5min) of the threshold elapsing.
      const host = createMemoryHost();
      // Sub-agent claimed at T-30min, terminated at T-25min (no
      // explicit release). agent-turn atoms only exist up to T-25min.
      const claim = buildPrDriverClaim({
        pr: PR,
        principal_id: 'dogfeed-21-sub-agent',
        claimed_at: new Date(NOW_MS - 30 * 60_000).toISOString() as Time,
      });
      await host.atoms.put(claim);
      // PR's last activity = CR review at T-12min.
      const lastActivity = new Date(NOW_MS - 12 * 60_000).toISOString() as Time;
      const source = new StaticOpenPrSource([
        { pr: PR, last_activity_at: lastActivity },
      ]);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
        claimantActivityScanner: new FixedActivityScanner(NOW_MS - 25 * 60_000),
      });
      expect(r.orphansDetected).toBe(1);
      expect(r.dispatched).toBe(1);
      expect(dispatcher.calls[0]!.orphan_reason).toBe('claimer-inactive');
      // Provenance chain back to the prior claim atom.
      const atomId = dispatcher.calls[0]!.orphan_atom_id;
      const atom = await host.atoms.get(atomId);
      expect(atom?.provenance.derived_from).toContain(claim.id);
      expect(atom?.metadata['prior_claim_id']).toBe(String(claim.id));
      expect(atom?.metadata['prior_claim_principal_id']).toBe('dogfeed-21-sub-agent');
    });
  });

  describe('observability', () => {
    it('skipped histogram counts every PR not classified as orphan', async () => {
      const host = createMemoryHost();
      const fresh = new Date(NOW_MS - 30_000).toISOString() as Time;
      const stale = new Date(NOW_MS - 10 * 60_000).toISOString() as Time;
      // Mix of fresh-no-claim, stale-no-claim, stale-with-active-claim.
      const claim = buildPrDriverClaim({
        pr: { owner: 'lag-org', repo: 'memory-governance', number: 100 },
        principal_id: 'sub-agent-A',
        claimed_at: new Date(NOW_MS - 60_000).toISOString() as Time,
      });
      await host.atoms.put(claim);
      const source = new StaticOpenPrSource([
        { pr: { owner: 'lag-org', repo: 'memory-governance', number: 1 }, last_activity_at: fresh },
        { pr: { owner: 'lag-org', repo: 'memory-governance', number: 2 }, last_activity_at: stale },
        { pr: { owner: 'lag-org', repo: 'memory-governance', number: 100 }, last_activity_at: fresh },
      ]);
      const dispatcher = new CapturingDispatcher();
      const r = await runPrOrphanReconcileTick(host, source, dispatcher, {
        now: () => NOW,
        principalId: 'lag-loop',
        thresholdMsOverride: FRESH_THRESHOLD_MS,
        claimantActivityScanner: new FixedActivityScanner(NOW_MS - 30_000),
      });
      expect(r.scanned).toBe(3);
      expect(r.orphansDetected).toBe(1); // only the stale-no-claim
      expect(r.skipped['no-claim-but-fresh']).toBe(1);
      expect(r.skipped['claim-active']).toBe(1);
    });
  });
});
