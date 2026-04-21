/**
 * Arbitration conflict fuzz.
 *
 * Mechanism this guards: two or more parallel writers producing
 * atoms that contradict the same canon atom must converge on a
 * deterministic final store state regardless of arrival order. The
 * fence ADR (design/adr-code-author-blast-radius-fence.md,
 * graduation criterion #3) cites this as a prerequisite for
 * autonomous code-author authority: an unfuzzed arbitration layer
 * under concurrent writes is a source-of-truth risk the HIL cannot
 * see.
 *
 * Scope of this suite (Memory host only):
 *   - source-rank axis: layer / provenance / principal-depth / confidence
 *   - temporal-scope axis: detector says temporal -> coexist
 *   - detector-none: non-conflicting atoms coexist without stack invocation
 *   - mixed arrival order: running the SAME input set in M different
 *     permutations yields an identical final atom set (by id + superseded_by)
 *
 * OPEN ITEM surfaced per dev-flag-structural-concerns:
 *   The fence ADR requires this fuzz green on the Postgres Host,
 *   not just Memory. Today no Postgres Host exists in the codebase
 *   (createFileHost + createMemoryHost + createBridgeHost are the
 *   shipped adapters; see src/adapters/). Shipping the Memory fuzz
 *   catches arbitration-logic non-determinism, which is where the
 *   substantive risk lives; Postgres-adapter-specific races
 *   (transactional isolation, optimistic concurrency) are a
 *   separate concern that will need their own fuzz once the
 *   Postgres adapter lands. The fence ADR graduation criterion
 *   therefore has TWO blockers from this PR's perspective:
 *     (a) this Memory fuzz (handled here)
 *     (b) Postgres adapter + Postgres-adapter fuzz (follow-up)
 *
 * Deterministic clock: MemoryHost's clock is set to a fixed start
 * and advanced deterministically between writes so wall-clock
 * variance does not leak non-determinism into the test.
 *
 * Deterministic LLM: arbitrate() uses the detect step's LLM judge
 * (Claude Haiku in prod). MemoryLLM's register() injects a
 * pre-canned response per (schema, system, data) tuple, so the
 * detector's behaviour is fully deterministic here.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import {
  applyDecision,
  arbitrate,
  DETECT_SCHEMA,
  DETECT_SYSTEM,
} from '../../src/arbitration/index.js';
import type { Atom, PrincipalId } from '../../src/types.js';
import { sampleAtom } from '../fixtures.js';

type MemoryHost = ReturnType<typeof createMemoryHost>;

const PRINCIPAL = 'fuzz_arbiter' as PrincipalId;

/**
 * Register a deterministic detector response for every unordered
 * pair of atoms in the list. The detect step canonicalises the
 * pair (atom_a vs atom_b) internally; we register BOTH orderings
 * so whichever parallel worker arrives first finds a cached
 * response regardless of which atom it calls "a".
 */
function registerDetectForPairs(
  host: MemoryHost,
  atoms: ReadonlyArray<Atom>,
  kind: 'semantic' | 'temporal' | 'none',
  explanation: string,
) {
  const response = { kind, explanation };
  for (let i = 0; i < atoms.length; i++) {
    for (let j = 0; j < atoms.length; j++) {
      if (i === j) continue;
      const a = atoms[i]!;
      const b = atoms[j]!;
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
  }
}

/**
 * Run `arbitrate + applyDecision` for every pair in `pairs` in the
 * given order, returning a normalized snapshot of the resulting
 * atom set. The snapshot captures {id, supersedes, superseded_by}
 * so two runs with identical outcomes serialize identically.
 */
async function playPairsInOrder(
  host: MemoryHost,
  pairs: ReadonlyArray<readonly [Atom, Atom]>,
): Promise<Array<{ id: string; supersedes: string[]; superseded_by: string[] }>> {
  for (const [a, b] of pairs) {
    const decision = await arbitrate(a, b, host, { principalId: PRINCIPAL });
    await applyDecision(decision, host, PRINCIPAL);
  }
  // Pass superseded:true so the snapshot captures atoms regardless of
  // whether they were superseded during arbitration. Default query
  // filters supersede'd atoms out, which would hide the very edges
  // the fuzz is asserting on.
  const { atoms } = await host.atoms.query({ superseded: true }, 200);
  return atoms
    .map((a) => ({
      id: String(a.id),
      supersedes: (a.supersedes ?? []).map(String).sort(),
      superseded_by: (a.superseded_by ?? []).map(String).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Fisher-Yates shuffle driven by a seeded PRNG so test runs are
 * reproducible when a failure surfaces.
 */
function seededShuffle<T>(xs: ReadonlyArray<T>, seed: number): T[] {
  const out = [...xs];
  let s = seed >>> 0;
  const rand = () => {
    // Linear congruential generator; plenty for fuzz permutation
    // selection, nothing cryptographic.
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('arbitration conflict fuzz', () => {
  it('source-rank axis: layer dominates across all arrival orders', async () => {
    // Three atoms on the same subject: L0 raw observation, L1
    // extracted claim, L3 canon directive. Canon MUST win regardless
    // of which pair arbitrates first. Detector says 'semantic' so
    // the source-rank rule fires.
    const SEEDS = [1, 2, 3, 7, 42, 1337];
    const snapshots: Array<typeof snapshot> = [];
    let snapshot: Awaited<ReturnType<typeof playPairsInOrder>> | null = null;

    for (const seed of SEEDS) {
      const host = createMemoryHost();
      const l0 = sampleAtom({ id: 'a_l0', content: 'X is false', layer: 'L0', confidence: 0.9 });
      const l1 = sampleAtom({ id: 'a_l1', content: 'X is mostly false', layer: 'L1', confidence: 0.8 });
      const l3 = sampleAtom({ id: 'a_l3', content: 'X is true', layer: 'L3', confidence: 1.0 });
      await host.atoms.put(l0);
      await host.atoms.put(l1);
      await host.atoms.put(l3);

      registerDetectForPairs(host, [l0, l1, l3], 'semantic', 'conflict on X');

      const pairs: Array<readonly [Atom, Atom]> = [
        [l0, l1],
        [l0, l3],
        [l1, l3],
      ];
      const shuffled = seededShuffle(pairs, seed);
      snapshot = await playPairsInOrder(host, shuffled);
      snapshots.push(snapshot);
    }

    // All snapshots must be identical: L3 canon transitively dominates.
    const first = JSON.stringify(snapshots[0]);
    for (const s of snapshots) {
      expect(JSON.stringify(s)).toBe(first);
    }
    // Shape check: L3 is the final winner (unbeaten), and L0 and L1
    // both carry a supersede edge to L3. Intermediate supersede
    // edges (L0 -> L1 when that pair arbitrated before L0 -> L3) are
    // retained in superseded_by by design - the list is the decision
    // history, not just the transitive winner. Convergence is what
    // the fuzz is really asserting; the shape check is the sanity.
    const l3Final = snapshots[0]!.find((x) => x.id === 'a_l3')!;
    const l0Final = snapshots[0]!.find((x) => x.id === 'a_l0')!;
    const l1Final = snapshots[0]!.find((x) => x.id === 'a_l1')!;
    expect(l3Final.superseded_by).toEqual([]);
    expect(l0Final.superseded_by).toContain('a_l3');
    expect(l1Final.superseded_by).toContain('a_l3');
  });

  it('source-rank axis: confidence breaks ties within equal layer+provenance+depth', async () => {
    // All three atoms at the same layer, same provenance kind, same
    // principal. Only confidence differs. Highest confidence must
    // win regardless of order.
    const SEEDS = [1, 2, 3, 11, 99];
    const snapshots: Array<Awaited<ReturnType<typeof playPairsInOrder>>> = [];

    for (const seed of SEEDS) {
      const host = createMemoryHost();
      // Content must be semantically distinct AFTER the content-hash
      // normalizer (lowercase + strip trailing punctuation). 'claim'
      // / 'CLAIM' / 'Claim.' all normalize to 'claim' and detect's
      // content-hash short-circuit then classifies the pairs as
      // reinforcement ('kind: none'), bypassing source-rank. Using
      // distinct text forces the LLM-judge path so the tiebreaker
      // under test actually runs.
      const low = sampleAtom({ id: 'c_low', content: 'claim alpha', confidence: 0.5 });
      const mid = sampleAtom({ id: 'c_mid', content: 'claim beta', confidence: 0.7 });
      const high = sampleAtom({ id: 'c_high', content: 'claim gamma', confidence: 0.9 });
      await host.atoms.put(low);
      await host.atoms.put(mid);
      await host.atoms.put(high);
      registerDetectForPairs(host, [low, mid, high], 'semantic', 'conflict on claim');

      const pairs: Array<readonly [Atom, Atom]> = [
        [low, mid],
        [low, high],
        [mid, high],
      ];
      const shuffled = seededShuffle(pairs, seed);
      snapshots.push(await playPairsInOrder(host, shuffled));
    }

    const first = JSON.stringify(snapshots[0]);
    for (const s of snapshots) expect(JSON.stringify(s)).toBe(first);
    // Pin the exact supersede graph so the confidence tiebreaker
    // is asserted, not inferred from "high was not beaten". Without
    // this, three coexisting atoms would still pass the winner
    // check (highFinal.superseded_by === []) because nobody was
    // superseded. Literal-expected-value per the test-contract
    // convention.
    expect(snapshots[0]).toEqual([
      { id: 'c_high', supersedes: ['c_low', 'c_mid'], superseded_by: [] },
      { id: 'c_low', supersedes: [], superseded_by: ['c_high', 'c_mid'] },
      { id: 'c_mid', supersedes: ['c_low'], superseded_by: ['c_high'] },
    ]);
  });

  it('detector-none: non-conflicting atoms coexist across all orderings', async () => {
    // Atoms that the detector declares unrelated. All orderings
    // yield the same all-coexist state.
    const SEEDS = [1, 2, 3, 5, 17];
    const snapshots: Array<Awaited<ReturnType<typeof playPairsInOrder>>> = [];

    for (const seed of SEEDS) {
      const host = createMemoryHost();
      const x = sampleAtom({ id: 'n_x', content: 'we use Postgres' });
      const y = sampleAtom({ id: 'n_y', content: 'the office is in Boston' });
      const z = sampleAtom({ id: 'n_z', content: 'standup is Tuesday' });
      await host.atoms.put(x);
      await host.atoms.put(y);
      await host.atoms.put(z);
      registerDetectForPairs(host, [x, y, z], 'none', 'unrelated subjects');

      const pairs: Array<readonly [Atom, Atom]> = [[x, y], [x, z], [y, z]];
      const shuffled = seededShuffle(pairs, seed);
      snapshots.push(await playPairsInOrder(host, shuffled));
    }

    const first = JSON.stringify(snapshots[0]);
    for (const s of snapshots) expect(JSON.stringify(s)).toBe(first);
    // No supersede edges at all.
    for (const row of snapshots[0]!) {
      expect(row.supersedes).toEqual([]);
      expect(row.superseded_by).toEqual([]);
    }
  });

  it('temporal-scope axis: equal-rank temporal pairs coexist regardless of order', async () => {
    // Temporal-scope runs AFTER source-rank in the arbitrate stack.
    // When source-rank can decide (layer/provenance/confidence
    // differs), it wins and temporal never branches. So the
    // temporal-scope rule only reaches its branch for atoms at equal
    // source-rank. This test pins that contract: same layer, same
    // confidence, same provenance, same principal -> source-rank
    // returns null -> temporal-scope fires on a detector 'temporal'
    // verdict -> both atoms coexist regardless of arrival order.
    //
    // Separately asserted elsewhere (test 1): when source-rank CAN
    // decide, source-rank wins, even if the detector says temporal.
    // That's the rule-ordering contract.
    const SEEDS = [1, 2, 3, 13, 29];
    const snapshots: Array<Awaited<ReturnType<typeof playPairsInOrder>>> = [];

    for (const seed of SEEDS) {
      const host = createMemoryHost();
      const old = sampleAtom({
        id: 't_old',
        content: 'we use Postgres',
        layer: 'L1',
        confidence: 0.8,
      });
      const newer = sampleAtom({
        id: 't_new',
        content: 'we use MySQL',
        layer: 'L1',
        confidence: 0.8,
      });
      await host.atoms.put(old);
      await host.atoms.put(newer);
      registerDetectForPairs(host, [old, newer], 'temporal', 'different time windows');

      const pairs: Array<readonly [Atom, Atom]> = [[old, newer]];
      const shuffled = seededShuffle(pairs, seed);
      snapshots.push(await playPairsInOrder(host, shuffled));
    }

    const first = JSON.stringify(snapshots[0]);
    for (const s of snapshots) expect(JSON.stringify(s)).toBe(first);
    for (const row of snapshots[0]!) {
      expect(row.supersedes).toEqual([]);
      expect(row.superseded_by).toEqual([]);
    }
  });

  it('source-rank beats temporal-scope when ranks differ (rule-ordering)', async () => {
    // Complement to the equal-rank temporal test above: even when
    // the detector returns 'temporal', if source-rank can decide the
    // pair (here: L3 vs L1), source-rank wins and temporal-scope
    // never branches. This is the rule-ordering contract.
    const host = createMemoryHost();
    const low = sampleAtom({ id: 'rt_l1', content: 'we use Postgres', layer: 'L1', confidence: 0.8 });
    const high = sampleAtom({ id: 'rt_l3', content: 'we use MySQL', layer: 'L3', confidence: 0.8 });
    await host.atoms.put(low);
    await host.atoms.put(high);
    registerDetectForPairs(host, [low, high], 'temporal', 'would-be temporal split');

    const snapshot = await playPairsInOrder(host, [[low, high]]);
    const lowFinal = snapshot.find((x) => x.id === 'rt_l1')!;
    const highFinal = snapshot.find((x) => x.id === 'rt_l3')!;
    expect(highFinal.superseded_by).toEqual([]);
    expect(lowFinal.superseded_by).toEqual(['rt_l3']);
  });

  it('large permutation space: source-rank convergence across many orderings', async () => {
    // Scale up: 5 atoms, 10 pair-combinations, permuted 20 different
    // ways. Canon atom should win every time. This is the "stress"
    // part of the fuzz - the earlier tests hit 6 seeds; this hits
    // 20 to catch rare-ordering bugs.
    const SEEDS = Array.from({ length: 20 }, (_, i) => (i + 1) * 3_000_017); // spread LCG phases
    const snapshots: Array<Awaited<ReturnType<typeof playPairsInOrder>>> = [];

    for (const seed of SEEDS) {
      const host = createMemoryHost();
      const atoms = [
        sampleAtom({ id: 'p_a', content: 'A', layer: 'L0', confidence: 0.6 }),
        sampleAtom({ id: 'p_b', content: 'B', layer: 'L1', confidence: 0.7 }),
        sampleAtom({ id: 'p_c', content: 'C', layer: 'L2', confidence: 0.8 }),
        sampleAtom({ id: 'p_d', content: 'D', layer: 'L3', confidence: 0.9 }),
        sampleAtom({ id: 'p_e', content: 'E', layer: 'L3', confidence: 1.0 }),
      ];
      for (const a of atoms) await host.atoms.put(a);
      registerDetectForPairs(host, atoms, 'semantic', 'all conflict');

      const pairs: Array<readonly [Atom, Atom]> = [];
      for (let i = 0; i < atoms.length; i++) {
        for (let j = i + 1; j < atoms.length; j++) {
          pairs.push([atoms[i]!, atoms[j]!]);
        }
      }
      const shuffled = seededShuffle(pairs, seed);
      snapshots.push(await playPairsInOrder(host, shuffled));
    }

    const first = JSON.stringify(snapshots[0]);
    for (const s of snapshots) expect(JSON.stringify(s)).toBe(first);

    // Pin the exact supersede graph. "p_e is unbeaten" alone would
    // still pass if other atoms also finished unbeaten (multiple
    // winners), which defeats the convergence claim. With the five
    // atoms on a strict source-rank ladder (L0 < L1 < L2 < L3 < L3+
    // higher confidence), every pair (x, y) with rank(x) > rank(y)
    // records x.supersedes += [y] and y.superseded_by += [x], so
    // the final graph is a complete chain.
    expect(snapshots[0]).toEqual([
      { id: 'p_a', supersedes: [], superseded_by: ['p_b', 'p_c', 'p_d', 'p_e'] },
      { id: 'p_b', supersedes: ['p_a'], superseded_by: ['p_c', 'p_d', 'p_e'] },
      { id: 'p_c', supersedes: ['p_a', 'p_b'], superseded_by: ['p_d', 'p_e'] },
      { id: 'p_d', supersedes: ['p_a', 'p_b', 'p_c'], superseded_by: ['p_e'] },
      { id: 'p_e', supersedes: ['p_a', 'p_b', 'p_c', 'p_d'], superseded_by: [] },
    ]);
  });
});
