import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { PromotionEngine } from '../../src/promotion/engine.js';
import type { AtomId, PrincipalId } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 'engine-test' as PrincipalId;

describe('PromotionEngine.findCandidates', () => {
  it('groups atoms by content-hash, counts distinct principals', async () => {
    const host = createMemoryHost();
    // Three observations of the same fact from different principals.
    // All three content strings must normalize to the same hash.
    // Normalizer rules: lowercase, collapse whitespace, strip trailing
    // punctuation. So variations in caps and trailing punct still match.
    await host.atoms.put(sampleAtom({
      id: 'a1' as AtomId,
      content: 'We use Postgres.',
      layer: 'L1',
      confidence: 0.8,
      principal_id: 'alice' as PrincipalId,
    }));
    await host.atoms.put(sampleAtom({
      id: 'a2' as AtomId,
      content: 'we use postgres', // caps/no-period variant; normalizes equal
      layer: 'L1',
      confidence: 0.8,
      principal_id: 'bob' as PrincipalId,
    }));
    await host.atoms.put(sampleAtom({
      id: 'a3' as AtomId,
      content: 'WE USE POSTGRES!', // caps + bang; normalizes equal
      layer: 'L1',
      confidence: 0.8,
      principal_id: 'carol' as PrincipalId,
    }));
    // Unrelated atom (different fact).
    await host.atoms.put(sampleAtom({
      id: 'a4' as AtomId,
      content: 'We use Redis.',
      layer: 'L1',
      confidence: 0.8,
      principal_id: 'alice' as PrincipalId,
    }));

    const engine = new PromotionEngine(host, { principalId: principal });
    const cands = await engine.findCandidates('L2');

    // Two content-hash classes: postgres (3 principals), redis (1).
    expect(cands.length).toBe(2);
    const postgres = cands.find(c => c.atom.content.toLowerCase().includes('postgres'));
    expect(postgres?.consensusCount).toBe(3);
    const redis = cands.find(c => c.atom.content.toLowerCase().includes('redis'));
    expect(redis?.consensusCount).toBe(1);
  });
});

describe('PromotionEngine.promote (L2 without human gate)', () => {
  it('promotes when policy passes: new atom at L2, representative superseded', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom({
      id: 'src1' as AtomId,
      content: 'we use postgres',
      layer: 'L1',
      confidence: 0.85,
      principal_id: 'alice' as PrincipalId,
    }));
    await host.atoms.put(sampleAtom({
      id: 'src2' as AtomId,
      content: 'we use postgres',
      layer: 'L1',
      confidence: 0.85,
      principal_id: 'bob' as PrincipalId,
    }));

    const engine = new PromotionEngine(host, { principalId: principal });
    const cands = await engine.findCandidates('L2');
    expect(cands.length).toBe(1);
    const candidate = cands[0]!;
    const out = await engine.promote(candidate, 'L2');
    expect(out.kind).toBe('promoted');
    expect(out.promotedAtomId).not.toBeNull();

    // The representative atom (candidate.atom = newest in the group) is
    // the one superseded; other atoms in the class remain unchanged so
    // their distinct provenance is preserved.
    const representativeAfter = await host.atoms.get(candidate.atom.id);
    expect(representativeAfter?.superseded_by.length).toBeGreaterThan(0);

    // New atom exists at L2.
    const promoted = await host.atoms.get(out.promotedAtomId!);
    expect(promoted?.layer).toBe('L2');
    expect(promoted?.provenance.kind).toBe('canon-promoted');
    expect(promoted?.supersedes).toContain(candidate.atom.id);
  });

  it('rejects when policy fails (e.g., consensus below threshold)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom({
      id: 'lonely' as AtomId,
      content: 'only one source',
      layer: 'L1',
      confidence: 0.95,
      principal_id: 'alice' as PrincipalId,
    }));
    const engine = new PromotionEngine(host, { principalId: principal });
    const cands = await engine.findCandidates('L2');
    const out = await engine.promote(cands[0]!, 'L2');
    expect(out.kind).toBe('rejected-by-policy');
    expect(out.promotedAtomId).toBeNull();
  });

  it('is idempotent: second promote on same candidate does not duplicate', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom({
      id: 'a' as AtomId,
      content: 'two sources agree',
      layer: 'L1',
      confidence: 0.85,
      principal_id: 'alice' as PrincipalId,
    }));
    await host.atoms.put(sampleAtom({
      id: 'b' as AtomId,
      content: 'two sources agree',
      layer: 'L1',
      confidence: 0.85,
      principal_id: 'bob' as PrincipalId,
    }));
    const engine = new PromotionEngine(host, { principalId: principal });
    const cands = await engine.findCandidates('L2');
    const first = await engine.promote(cands[0]!, 'L2');
    const second = await engine.promote(cands[0]!, 'L2');
    // Both succeed; second returns the same promoted atom id.
    expect(first.kind).toBe('promoted');
    expect(second.kind).toBe('promoted');
    expect(second.promotedAtomId).toBe(first.promotedAtomId);
    const atomsAtL2 = (await host.atoms.query({ layer: ['L2'] }, 100)).atoms;
    expect(atomsAtL2.length).toBe(1);
  });

  it('audits the promotion decision', async () => {
    const host = createMemoryHost();
    await host.atoms.put(sampleAtom({ id: 'x' as AtomId, content: 'fact', layer: 'L1', confidence: 0.85, principal_id: 'alice' as PrincipalId }));
    await host.atoms.put(sampleAtom({ id: 'y' as AtomId, content: 'fact', layer: 'L1', confidence: 0.85, principal_id: 'bob' as PrincipalId }));
    const engine = new PromotionEngine(host, { principalId: principal });
    await engine.runPass('L2');
    const audits = await host.auditor.query({ kind: ['promotion.applied'] }, 10);
    expect(audits.length).toBe(1);
    expect(audits[0]?.details).toMatchObject({
      target_layer: 'L2',
      consensus_count: 2,
    });
  });
});

describe('PromotionEngine.promote (L3 with human gate)', () => {
  it('escalates to notifier and promotes on approve', async () => {
    const host = createMemoryHost();
    // Three distinct L2 atoms with same content (via promotion).
    // Easier: create three distinct L2 atoms directly with same content-hash.
    for (let i = 0; i < 3; i++) {
      await host.atoms.put(sampleAtom({
        id: `l2_${i}` as AtomId,
        content: 'canonical architectural decision',
        layer: 'L2',
        confidence: 0.95,
        principal_id: `p_${i}` as PrincipalId,
      }));
    }
    const engine = new PromotionEngine(host, {
      principalId: principal,
      humanGateTimeoutMs: 500,
    });
    const cands = await engine.findCandidates('L3');
    expect(cands.length).toBe(1);

    // Launch promote and concurrently approve the notification.
    const promotePromise = engine.promote(cands[0]!, 'L3');
    // Give the engine time to issue telegraph, then approve the only pending handle.
    await new Promise(r => setTimeout(r, 30));
    // Recompute the handle the notifier produced.
    const { createHash } = await import('node:crypto');
    const now = host.clock.now();
    const summary = `Promote ${String(cands[0]!.atom.id)} to L3`;
    const handle = createHash('sha256')
      .update(summary, 'utf8')
      .update('|', 'utf8')
      .update(now, 'utf8')
      .digest('hex')
      .slice(0, 24);
    await host.notifier.respond(handle as never, 'approve', principal);

    const out = await promotePromise;
    expect(out.kind).toBe('promoted');
    expect(out.promotedAtomId).not.toBeNull();
    const promoted = await host.atoms.get(out.promotedAtomId!);
    expect(promoted?.layer).toBe('L3');
  });

  it('rejects on human reject', async () => {
    const host = createMemoryHost();
    for (let i = 0; i < 3; i++) {
      await host.atoms.put(sampleAtom({
        id: `l2r_${i}` as AtomId,
        content: 'rejected promotion',
        layer: 'L2',
        confidence: 0.95,
        principal_id: `pr_${i}` as PrincipalId,
      }));
    }
    const engine = new PromotionEngine(host, {
      principalId: principal,
      humanGateTimeoutMs: 500,
    });
    const cands = await engine.findCandidates('L3');
    const promotePromise = engine.promote(cands[0]!, 'L3');
    await new Promise(r => setTimeout(r, 30));

    const { createHash } = await import('node:crypto');
    const now = host.clock.now();
    const summary = `Promote ${String(cands[0]!.atom.id)} to L3`;
    const handle = createHash('sha256').update(summary, 'utf8').update('|', 'utf8').update(now, 'utf8').digest('hex').slice(0, 24);
    await host.notifier.respond(handle as never, 'reject', principal);

    const out = await promotePromise;
    expect(out.kind).toBe('rejected-by-human');
    expect(out.promotedAtomId).toBeNull();
    // No new L3 atom.
    const l3 = (await host.atoms.query({ layer: ['L3'] }, 10)).atoms;
    expect(l3.length).toBe(0);
  });

  it('times out to "timed-out-awaiting-human" when notifier times out', async () => {
    const host = createMemoryHost();
    for (let i = 0; i < 3; i++) {
      await host.atoms.put(sampleAtom({
        id: `l2t_${i}` as AtomId,
        content: 'timeout promotion',
        layer: 'L2',
        confidence: 0.95,
        principal_id: `pt_${i}` as PrincipalId,
      }));
    }
    const engine = new PromotionEngine(host, {
      principalId: principal,
      humanGateTimeoutMs: 50,
    });
    const cands = await engine.findCandidates('L3');
    const out = await engine.promote(cands[0]!, 'L3');
    expect(out.kind).toBe('timed-out-awaiting-human');
    expect(out.promotedAtomId).toBeNull();
  });
});
