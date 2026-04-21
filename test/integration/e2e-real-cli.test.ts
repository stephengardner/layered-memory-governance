/**
 * End-to-end integration test: real Claude CLI drives the full arbitration
 * stack.
 *
 * This test composes a Host whose `llm` slot is ClaudeCliLLM (real CLI, OAuth
 * auth, no API key) and everything else is the in-memory reference adapter.
 * It then exercises the complete detect -> source-rank -> applyDecision path
 * without any mock.
 *
 * Gated by LAG_REAL_CLI=1 + claude binary on PATH, like the smoke test.
 */

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { ClaudeCliLLM } from '../../src/adapters/claude-cli/llm.js';
import {
  applyDecision,
  arbitrate,
} from '../../src/arbitration/index.js';
import type { Host } from '../../src/substrate/interface.js';
import type { LLM } from '../../src/substrate/interface.js';
import type { PrincipalId } from '../../src/substrate/types.js';
import { sampleAtom } from '../fixtures.js';

const RUN_REAL = process.env.LAG_REAL_CLI === '1';

async function claudeIsAvailable(): Promise<boolean> {
  try {
    const r = await execa('claude', ['--version'], { timeout: 5000, reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

const available = RUN_REAL ? await claudeIsAvailable() : false;

/**
 * Compose a Host that uses real CLI for llm but everything else in-memory.
 * Returns both the Host (for framework code) and the underlying MemoryHost
 * (for test assertions that need atom-store helpers, audit peek, etc.).
 */
function createIntegrationHost(): {
  host: Host;
  mem: ReturnType<typeof createMemoryHost>;
  llm: ClaudeCliLLM;
} {
  const mem = createMemoryHost();
  const llm = new ClaudeCliLLM({ verbose: true });
  // Substitute llm slot. The MemoryHost interface declares llm as MemoryLLM;
  // tests can narrow or widen as needed.
  const host: Host = { ...mem, llm: llm as unknown as LLM };
  return { host, mem, llm };
}

const principal = 'e2e-agent' as PrincipalId;

describe.skipIf(!RUN_REAL || !available)('E2E with real Claude CLI: arbitration stack', () => {
  it(
    'real CLI classifies semantic conflict; source-rank resolves; loser superseded',
    async () => {
      const { host, mem } = createIntegrationHost();

      // Two present-tense contradictory claims about the same fact.
      // Designed to minimize temporal-classification ambiguity so source-rank
      // is the expected resolution path.
      const obs = sampleAtom({
        content:
          'We use Postgres as the canonical database for all user data in production.',
        layer: 'L1',
        confidence: 0.5,
        provenance: {
          kind: 'agent-observed',
          source: { agent_id: 'scripted-observer' },
          derived_from: [],
        },
      });
      const dir = sampleAtom({
        content:
          'Directive: always use MySQL as the canonical database for all user data in production. Do not use Postgres.',
        layer: 'L1',
        confidence: 0.9,
        provenance: {
          kind: 'user-directive',
          source: { agent_id: 'user' },
          derived_from: [],
        },
      });

      await host.atoms.put(obs);
      await host.atoms.put(dir);

      console.log('[E2E] invoking arbitrate with real CLI...');
      const start = Date.now();
      const decision = await arbitrate(dir, obs, host, {
        principalId: principal,
        escalationTimeoutMs: 5_000,
        detect: {
          model: 'claude-haiku-4-5',
          maxBudgetUsd: 0.35,
        },
      });
      console.log(`[E2E] arbitrate returned in ${Date.now() - start}ms`);
      await applyDecision(decision, host, principal);

      // Log Claude's actual classification + explanation for the findings doc.
      // eslint-disable-next-line no-console
      console.log('[E2E] detector kind:', decision.pair.kind);
      // eslint-disable-next-line no-console
      console.log('[E2E] detector explanation:', decision.pair.explanation);
      // eslint-disable-next-line no-console
      console.log('[E2E] rule applied:', decision.ruleApplied);
      // eslint-disable-next-line no-console
      console.log('[E2E] outcome:', decision.outcome.kind, '-', decision.outcome.reason);

      // Accept either semantic (source-rank resolves) or temporal (coexist)
      // as valid LAG behavior. The test asserts the whole flow completes
      // without error and that, whichever classification the model made,
      // LAG's response is coherent.
      expect(['semantic', 'temporal', 'none']).toContain(decision.pair.kind);

      if (decision.pair.kind === 'semantic') {
        expect(decision.ruleApplied).toBe('source-rank');
        expect(decision.outcome.kind).toBe('winner');
        if (decision.outcome.kind === 'winner') {
          // user-directive should beat agent-observed on source-rank.
          expect(decision.outcome.winner).toBe(dir.id);
          expect(decision.outcome.loser).toBe(obs.id);
        }
        const loser = await host.atoms.get(obs.id);
        expect(loser?.superseded_by).toContain(dir.id);
      } else if (decision.pair.kind === 'temporal') {
        expect(decision.ruleApplied).toBe('temporal-scope');
        expect(decision.outcome.kind).toBe('coexist');
      }

      // Audit log recorded the decision.
      const audits = await host.auditor.query(
        { kind: ['arbitration.decision'] },
        10,
      );
      expect(audits.length).toBe(1);
      expect(audits[0]?.details['rule']).toBe(decision.ruleApplied);

      // Memory adapter kept the memory adapter's contract even with a real LLM.
      expect(mem.atoms.size()).toBe(2);
    },
    300_000,
  );

  it(
    'content-hash shortcut avoids an LLM call for reinforcement',
    async () => {
      const { host } = createIntegrationHost();
      const a = sampleAtom({ content: 'Use Postgres.' });
      const b = sampleAtom({ content: 'use postgres' }); // normalizes to same hash
      const before = Date.now();
      const decision = await arbitrate(a, b, host, {
        principalId: principal,
        escalationTimeoutMs: 5_000,
      });
      const elapsed = Date.now() - before;
      expect(decision.pair.kind).toBe('none');
      expect(decision.outcome.kind).toBe('coexist');
      // No LLM call means this must be FAST (< 500ms typically; allow 2000 for safety).
      expect(elapsed).toBeLessThan(2_000);
    },
    10_000,
  );
});
