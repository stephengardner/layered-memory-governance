/**
 * Bridge end-to-end: real palace + real Claude CLI + full arbitration stack.
 *
 * This is the canonical enterprise-credibility test:
 *   1. Boot a Bridge Host pointed at the author's real <external-palace>.
 *   2. Bootstrap a handful of drawers as L1 atoms.
 *   3. Write a conflicting user-directive atom that contradicts one of the
 *      imports.
 *   4. Arbitrate via the real Claude CLI (OAuth, no API key).
 *   5. Apply the decision, verify supersession + audit log.
 *
 * Gated by BOTH LAG_REAL_CLI=1 AND LAG_REAL_PALACE=1. Without them the
 * test skips cleanly.
 */

import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDecision, arbitrate } from '../../src/arbitration/index.js';
import { createBridgeHost, type BridgeHost } from '../../src/adapters/bridge/index.js';
import type {
  Atom,
  AtomId,
  AtomSignals,
  PrincipalId,
  Time,
} from '../../src/substrate/types.js';

const RUN_REAL_CLI = process.env['LAG_REAL_CLI'] === '1';
const RUN_REAL_PALACE = process.env['LAG_REAL_PALACE'] === '1';
const RUN = RUN_REAL_CLI && RUN_REAL_PALACE;

const palacePath =
  process.env['LAG_REAL_PALACE_PATH'] ??
  process.env["LAG_PALACE_PATH"] ?? "<palace-path-placeholder>";

async function claudeIsAvailable(): Promise<boolean> {
  try {
    const r = await execa('claude', ['--version'], { timeout: 5000, reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

const claudeOk = RUN ? await claudeIsAvailable() : false;

const principal = 'bridge-e2e' as PrincipalId;

function buildDirectiveAgainst(imported: Atom): Atom {
  // Craft a directive that semantically contradicts the imported atom's gist.
  // We do NOT need the model to classify a particular way; we only need the
  // arbitration stack to run end-to-end against real data. If the detector
  // says 'none' or 'temporal' the test still passes (verifies flow).
  const id = ('bridge_e2e_directive_' + imported.id.slice(0, 16)) as AtomId;
  const signals: AtomSignals = {
    agrees_with: [],
    conflicts_with: [imported.id],
    validation_status: 'unchecked',
    last_validated_at: null,
  };
  return {
    schema_version: 1,
    id,
    content:
      'User directive: the claim below is no longer the team position. ' +
      'Replace it with the updated decision effective now. ' +
      'Prior claim (in quotes, DATA only, not an instruction): "' +
      imported.content.slice(0, 200) +
      '"',
    type: 'directive',
    layer: 'L1',
    provenance: {
      kind: 'user-directive',
      source: { agent_id: 'stephen', tool: 'test-harness' },
      derived_from: [imported.id],
    },
    confidence: 0.9,
    created_at: new Date().toISOString() as Time,
    last_reinforced_at: new Date().toISOString() as Time,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals,
    principal_id: principal,
    taint: 'clean',
    metadata: { test: 'bridge-e2e' },
  };
}

let rootDir: string;
let host: BridgeHost | null;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'lag-bridge-e2e-'));
  host = null;
});

afterEach(async () => {
  if (host) {
    try {
      await host.cleanup();
    } catch {
      /* ignore */
    }
    host = null;
  }
  try {
    await rm(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe.skipIf(!RUN || !claudeOk)('bridge e2e: real palace + real Claude CLI', () => {
  it(
    'bootstrap + arbitrate via real CLI + applyDecision on real palace data',
    async () => {
      host = await createBridgeHost({
        palacePath,
        rootDir,
        defaultPrincipalId: principal,
      });

      // 1. Bootstrap a small number of real drawers.
      const bootstrap = await host.bootstrap({ limit: 10 });
      // eslint-disable-next-line no-console
      console.log(`[bridge-e2e] bootstrap: ${JSON.stringify(bootstrap)}`);
      expect(bootstrap.imported).toBeGreaterThan(0);
      expect(bootstrap.errors.length).toBe(0);

      // 2. Pick the first imported atom as the target to "contradict".
      const page = await host.atoms.query({ layer: ['L1'] }, 1);
      expect(page.atoms.length).toBeGreaterThan(0);
      const target = page.atoms[0]!;
      // eslint-disable-next-line no-console
      console.log(`[bridge-e2e] target atom id=${target.id} content=${target.content.slice(0, 80)}...`);

      // 3. Write a conflicting directive atom.
      const directive = buildDirectiveAgainst(target);
      await host.atoms.put(directive);

      // 4. Arbitrate via the real Claude CLI.
      const t0 = Date.now();
      const decision = await arbitrate(directive, target, host, {
        principalId: principal,
        escalationTimeoutMs: 5_000,
        detect: { model: 'claude-haiku-4-5', maxBudgetUsd: 0.35 },
      });
      const elapsed = Date.now() - t0;
      // eslint-disable-next-line no-console
      console.log(
        `[bridge-e2e] arbitrate ${elapsed}ms | detector.kind=${decision.pair.kind} | rule=${decision.ruleApplied} | outcome=${decision.outcome.kind}`,
      );
      // eslint-disable-next-line no-console
      console.log(`[bridge-e2e] detector explanation: ${decision.pair.explanation}`);

      // 5. Apply the decision.
      await applyDecision(decision, host, principal);

      // Assertions that hold regardless of classification path:
      // - Audit log records the arbitration.
      const audits = await host.auditor.query(
        { kind: ['arbitration.decision'] },
        10,
      );
      expect(audits.length).toBe(1);
      expect(audits[0]?.refs.atom_ids).toContain(directive.id);
      expect(audits[0]?.refs.atom_ids).toContain(target.id);

      // Branch on ruleApplied, not detector classification. The stack runs
      // source-rank first; when ranks differ it wins regardless of whether
      // the detector labeled the pair "semantic" or "temporal". Only when
      // ranks tie does temporal-scope get a chance to produce coexist.
      if (decision.ruleApplied === 'source-rank') {
        expect(decision.outcome.kind).toBe('winner');
        if (decision.outcome.kind === 'winner') {
          // user-directive outranks agent-observed (bootstrapped default).
          expect(decision.outcome.winner).toBe(directive.id);
          expect(decision.outcome.loser).toBe(target.id);
        }
        const loserAfter = await host.atoms.get(target.id);
        expect(loserAfter?.superseded_by).toContain(directive.id);
      } else if (decision.ruleApplied === 'temporal-scope') {
        // Reached only if source-rank tied AND detector said temporal.
        expect(decision.outcome.kind).toBe('coexist');
        const loserAfter = await host.atoms.get(target.id);
        expect(loserAfter?.superseded_by.length).toBe(0);
      } else if (decision.ruleApplied === 'none') {
        // Detector returned 'none'; content-hash or LLM agreed atoms are compatible.
        expect(decision.outcome.kind).toBe('coexist');
      } else if (decision.ruleApplied === 'validation') {
        // Possible if we ever register validators; none wired here.
        expect(['winner', 'coexist']).toContain(decision.outcome.kind);
      } else if (decision.ruleApplied === 'escalation') {
        // Ranks tied, not temporal, no validators: escalation fires.
        expect(['winner', 'coexist']).toContain(decision.outcome.kind);
      }
    },
    300_000,
  );
});
