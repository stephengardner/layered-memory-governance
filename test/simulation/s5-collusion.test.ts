/**
 * Scenario 5: adversarial injection via colluding principals.
 *
 * Threat model: two principals collude to fake consensus. They each write
 * identical content at L1, so the L2 promotion pass sees 2 distinct
 * principals on one content-hash group. Under DEFAULT_THRESHOLDS
 * (L2 consensus=2), L2 promotion succeeds. L3, however, requires
 * consensus=3; which cannot be met by the single promoted L2 atom on
 * its own. The collusion is bounded at L2 and never reaches canon.
 *
 * Governance property under test: **two colluders alone cannot produce a
 * canon entry**, no matter how many ticks the loop runs.
 *
 * Also asserts: an honest minority opinion sits at L1 with no forward
 * movement, so there is no false-parity effect.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { LoopRunner } from '../../src/loop/runner.js';
import { renderCanonMarkdown } from '../../src/canon-md/generator.js';
import type { AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const loopPrincipal = 's5-loop' as PrincipalId;

async function seedCollusionScene(host: ReturnType<typeof createMemoryHost>) {
  const now = host.clock.now();

  // Two colluders (mallory1 and mallory2) write the SAME (normalized-equal)
  // content. Leading token, casing, and trailing punctuation all collapse
  // under the content-hash normalizer.
  const colluderContents = [
    'Use MySQL as the canonical production database.',
    'use mysql as the canonical production database',
  ];
  for (let i = 0; i < colluderContents.length; i++) {
    await host.atoms.put(sampleAtom({
      id: (`mallory_${i}_atom`) as AtomId,
      content: colluderContents[i]!,
      type: 'decision',
      layer: 'L1',
      confidence: 0.95,
      principal_id: (`mallory_${i}`) as PrincipalId,
      created_at: now as Time,
      last_reinforced_at: now as Time,
    }));
  }

  // One honest dissenter with a different (non-normalizing-equal) statement.
  await host.atoms.put(sampleAtom({
    id: 'alice_atom' as AtomId,
    content: 'Use Postgres as the canonical production database.',
    type: 'decision',
    layer: 'L1',
    confidence: 0.95,
    principal_id: 'alice' as PrincipalId,
    created_at: now as Time,
    last_reinforced_at: now as Time,
  }));
}

describe('Scenario 5: adversarial injection (two colluders)', () => {
  it('colluders reach L2 (expected) but never reach L3 (governance holds)', async () => {
    const host = createMemoryHost();
    await seedCollusionScene(host);

    const runner = new LoopRunner(host, {
      principalId: loopPrincipal,
      l3HumanGateTimeoutMs: 100,
      runCanonApplier: false, // we render manually below
    });

    // Five ticks should give every pass plenty of opportunity. Each one is
    // idempotent; the invariant is that canon never surfaces the colluders.
    for (let i = 0; i < 5; i++) {
      await runner.tick();
    }

    // L2: the colluder class has been promoted once. Alice's class was
    // consensus=1, rejected.
    const l2 = (await host.atoms.query({ layer: ['L2'] }, 20)).atoms;
    expect(l2.length).toBe(1);
    expect(l2[0]?.content.toLowerCase()).toContain('mysql');
    expect(l2[0]?.provenance.kind).toBe('canon-promoted');

    // L3: no atoms. Consensus=1 on the single L2 atom's content hash cannot
    // satisfy L3's minConsensus=3.
    const l3 = (await host.atoms.query({ layer: ['L3'] }, 20)).atoms;
    expect(l3.length).toBe(0);

    // Canon as rendered from L3 is empty-state.
    const rendered = renderCanonMarkdown([], { now: host.clock.now() });
    expect(rendered).toContain('No canon atoms yet');
  });

  it('audit log records promotion.rejected for the L3 attempt', async () => {
    const host = createMemoryHost();
    await seedCollusionScene(host);

    const runner = new LoopRunner(host, {
      principalId: loopPrincipal,
      l3HumanGateTimeoutMs: 100,
      runCanonApplier: false,
    });
    await runner.tick(); // L2 promotion happens here
    await runner.tick(); // L3 promotion attempt happens here (against the fresh L2 atom)

    // Policy rejection carries consensus_count and the failing-reasons list.
    const rejected = await host.auditor.query(
      { kind: ['promotion.rejected.policy'] },
      20,
    );
    const l3Rejections = rejected.filter(
      e => e.details['target_layer'] === 'L3',
    );
    expect(l3Rejections.length).toBeGreaterThan(0);
    for (const e of l3Rejections) {
      expect(e.details['consensus_count']).toBe(1);
      const reasons = e.details['reasons'] as string[];
      expect(reasons.join(' ')).toMatch(/consensus \d+ < minConsensus/);
    }
  });

  it('honest dissenter stays at L1 (no spurious forward motion)', async () => {
    const host = createMemoryHost();
    await seedCollusionScene(host);

    const runner = new LoopRunner(host, {
      principalId: loopPrincipal,
      l3HumanGateTimeoutMs: 100,
      runCanonApplier: false,
    });
    await runner.tick();
    await runner.tick();

    const alice = await host.atoms.get('alice_atom' as AtomId);
    expect(alice?.layer).toBe('L1');
    expect(alice?.superseded_by.length).toBe(0);
  });

  it('L2 colluder atom is flagged by validator-backed promotion if registered (defense-in-depth)', async () => {
    // Documents the 3-principal bound: if a third principal joined the
    // collusion, the framework alone cannot distinguish honest consensus
    // from collusion. The defense beyond that is (a) the L3 human gate,
    // (b) validator-registry backed content checks, (c) compromised-
    // principal taint propagation (scenario 6).
    //
    // This test exercises path (b): a validator that flags mysql-vs-
    // postgres as invalid blocks L2 promotion even though consensus is met.
    const host = createMemoryHost();
    await seedCollusionScene(host);

    const { ValidatorRegistry } = await import('../../src/arbitration/validation.js');
    const { PromotionEngine } = await import('../../src/promotion/engine.js');

    const validators = new ValidatorRegistry();
    validators.register(async atom =>
      atom.content.toLowerCase().includes('mysql') ? 'invalid' : 'unverifiable',
    );

    const engine = new PromotionEngine(host, {
      principalId: loopPrincipal,
      validators,
      thresholds: {
        L2: { minConfidence: 0.7, minConsensus: 2, requireValidation: true },
        L3: { minConfidence: 0.9, minConsensus: 3, requireValidation: true, requireHumanApproval: true },
      },
    });
    const outcomes = await engine.runPass('L2');
    // The colluder class should be blocked by the validator; alice's class
    // stays below consensus.
    const promoted = outcomes.filter(o => o.kind === 'promoted');
    expect(promoted.length).toBe(0);
    const l2 = (await host.atoms.query({ layer: ['L2'] }, 20)).atoms;
    expect(l2.length).toBe(0);
  });
});
