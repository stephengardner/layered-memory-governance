import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  applyDecision,
  arbitrate,
  DETECT_SCHEMA,
  DETECT_SYSTEM,
  ValidatorRegistry,
} from '../../src/arbitration/index.js';
import type { PrincipalId } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const principal = 'arbiter_test' as PrincipalId;

function registerDetect(
  host: ReturnType<typeof createMemoryHost>,
  a: ReturnType<typeof sampleAtom>,
  b: ReturnType<typeof sampleAtom>,
  response: { kind: 'semantic' | 'temporal' | 'none'; explanation: string },
) {
  host.llm.register(
    DETECT_SCHEMA,
    DETECT_SYSTEM,
    {
      atom_a: { content: a.content, type: a.type, layer: a.layer, created_at: a.created_at },
      atom_b: { content: b.content, type: b.type, layer: b.layer, created_at: b.created_at },
    },
    response,
  );
}

describe('arbitrate (composed)', () => {
  it('detector-none returns coexist without invoking other rules', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({ content: 'Use Postgres.' });
    const b = sampleAtom({ content: 'use postgres' }); // content-hash match
    const decision = await arbitrate(a, b, host, { principalId: principal });
    expect(decision.pair.kind).toBe('none');
    expect(decision.outcome.kind).toBe('coexist');
    expect(decision.ruleApplied).toBe('none');
  });

  it('source-rank resolves when one atom clearly outranks the other', async () => {
    const host = createMemoryHost();
    const directive = sampleAtom({
      content: 'Always use Postgres.',
      layer: 'L1',
      provenance: { kind: 'user-directive', source: {}, derived_from: [] },
    });
    const observed = sampleAtom({
      content: 'Team used MySQL last sprint.',
      layer: 'L1',
      provenance: { kind: 'agent-observed', source: {}, derived_from: [] },
    });
    registerDetect(host, directive, observed, {
      kind: 'semantic',
      explanation: 'DB choice conflict',
    });
    const decision = await arbitrate(directive, observed, host, { principalId: principal });
    expect(decision.ruleApplied).toBe('source-rank');
    expect(decision.outcome.kind).toBe('winner');
    if (decision.outcome.kind === 'winner') {
      expect(decision.outcome.winner).toBe(directive.id);
      expect(decision.outcome.loser).toBe(observed.id);
    }
  });

  it('temporal-scope produces coexist', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({ content: 'We used Redux in 2020.' });
    const b = sampleAtom({ content: 'We use Zustand in 2026.' });
    registerDetect(host, a, b, { kind: 'temporal', explanation: 'Different times.' });
    const decision = await arbitrate(a, b, host, { principalId: principal });
    expect(decision.pair.kind).toBe('temporal');
    expect(decision.ruleApplied).toBe('temporal-scope');
    expect(decision.outcome.kind).toBe('coexist');
  });

  it('validation resolves when registry verifies one and not the other', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({
      content: 'README.md exists.',
      layer: 'L1',
      confidence: 0.5,
    });
    const b = sampleAtom({
      content: 'README.md does not exist.',
      layer: 'L1',
      confidence: 0.5,
    });
    registerDetect(host, a, b, { kind: 'semantic', explanation: 'Opposite claims.' });

    const validators = new ValidatorRegistry();
    validators.register(async atom => {
      // Pretend we checked the world: "README.md exists" is verified.
      if (atom.content.includes('does not exist')) return 'invalid';
      if (atom.content.includes('exists')) return 'verified';
      return 'unverifiable';
    });

    const decision = await arbitrate(a, b, host, {
      principalId: principal,
      validators,
    });
    expect(decision.ruleApplied).toBe('validation');
    expect(decision.outcome.kind).toBe('winner');
    if (decision.outcome.kind === 'winner') {
      expect(decision.outcome.winner).toBe(a.id);
    }
  });

  it('escalation coexist on timeout when all rules tie', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({ content: 'A is true.', layer: 'L1', confidence: 0.5 });
    const b = sampleAtom({ content: 'B is true.', layer: 'L1', confidence: 0.5 });
    registerDetect(host, a, b, { kind: 'semantic', explanation: 'Genuine tie.' });
    const decision = await arbitrate(a, b, host, {
      principalId: principal,
      escalationTimeoutMs: 50, // short so the test completes fast
    });
    expect(decision.ruleApplied).toBe('escalation');
    expect(decision.outcome.kind).toBe('coexist');
  });

  it('escalation winner when human approves', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({ content: 'A is true.', layer: 'L1', confidence: 0.5 });
    const b = sampleAtom({ content: 'B is true.', layer: 'L1', confidence: 0.5 });
    registerDetect(host, a, b, { kind: 'semantic', explanation: 'Genuine tie.' });

    // Run arbitrate and human-respond concurrently.
    const arbPromise = arbitrate(a, b, host, {
      principalId: principal,
      escalationTimeoutMs: 500,
    });

    // Poll the notifier for the pending handle and respond approve.
    const responderPrincipal = 'human_responder' as PrincipalId;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 20));
      if (host.notifier.size() > 0) {
        // Reconstruct the handle the way the Notifier does.
        // Simpler: respond to whatever is pending.
        // The memory notifier stores handles in an internal map; we cannot enumerate
        // without a test helper. Instead, respond via the well-known handle pattern.
        // Workaround: iterate through handles we seeded. For V0 simplicity, just give
        // the concurrency a chance; the test runs with a short timeout if needed.
        break;
      }
    }
    // Use the internal _forceStatus helper: scan entries and approve pending ones.
    // Since MemoryNotifier has no enumerator, we fall back to the well-known derived
    // handle using the same hashing the Notifier applies.
    // However, the event summary uses atom.id strings that change per test run.
    // Best: poll the internal state via size(), and inject the approve by calling
    // respond on a handle recovered by recomputing.
    // Simplest robust approach: construct the handle using the Notifier's telegraph
    // which is idempotent.
    const { createHash } = await import('node:crypto');
    const now = decisionEventCreatedAt(host);
    const summary = `Arbitration escalation: ${String(a.id)} vs ${String(b.id)}`;
    const handle = createHash('sha256').update(summary, 'utf8').update('|', 'utf8').update(now, 'utf8').digest('hex').slice(0, 24);
    await host.notifier.respond(handle as never, 'approve', responderPrincipal);

    const decision = await arbPromise;
    expect(decision.ruleApplied).toBe('escalation');
    expect(decision.outcome.kind).toBe('winner');
    if (decision.outcome.kind === 'winner') {
      expect(decision.outcome.winner).toBe(a.id);
    }
  });
});

// Helper: peek at the most recent event timestamp the clock has produced.
// The escalate() call records the event at host.clock.now() AFTER the clock's
// current state at arbitrate-call time. Tests start the host at default time
// and do not advance, so every call to clock.now() returns the initial time.
function decisionEventCreatedAt(host: ReturnType<typeof createMemoryHost>): string {
  return host.clock.now();
}

describe('applyDecision', () => {
  it('winner outcome marks loser superseded_by winner', async () => {
    const host = createMemoryHost();
    const a = sampleAtom({ content: 'Winner content' });
    const b = sampleAtom({ content: 'Loser content' });
    await host.atoms.put(a);
    await host.atoms.put(b);
    await applyDecision(
      {
        pair: { a, b, kind: 'semantic', explanation: 'test' },
        outcome: { kind: 'winner', winner: a.id, loser: b.id, reason: 'test' },
        ruleApplied: 'source-rank',
      },
      host,
      principal,
    );
    const loser = await host.atoms.get(b.id);
    expect(loser?.superseded_by).toContain(a.id);
    const winner = await host.atoms.get(a.id);
    expect(winner?.supersedes).toContain(b.id);
  });

  it('coexist outcome does not mutate atoms, but logs to audit', async () => {
    const host = createMemoryHost();
    const a = sampleAtom();
    const b = sampleAtom();
    await host.atoms.put(a);
    await host.atoms.put(b);
    const auditBefore = host.auditor.size();
    await applyDecision(
      {
        pair: { a, b, kind: 'temporal', explanation: 'test' },
        outcome: { kind: 'coexist', reason: 'temporal' },
        ruleApplied: 'temporal-scope',
      },
      host,
      principal,
    );
    expect(host.auditor.size()).toBeGreaterThan(auditBefore);
    const aAfter = await host.atoms.get(a.id);
    const bAfter = await host.atoms.get(b.id);
    expect(aAfter?.supersedes.length).toBe(0);
    expect(bAfter?.superseded_by.length).toBe(0);
  });
});
