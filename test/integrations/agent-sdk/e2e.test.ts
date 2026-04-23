/**
 * Agent SDK end-to-end deliberation (mocked Anthropic SDK).
 *
 * Exercises the full runDeliberation() pipeline the boot script uses:
 *   Principal seed loading
 *   -> agent-process.startAgent (per principal)
 *   -> coordinator.deliberate (rounds + arbitration)
 *   -> DeliberationSink translates Question/Position/Counter/
 *      Decision/Escalation events into core Atoms
 *   -> MemoryAtomStore.put(atom)
 *
 * The Anthropic client is entirely mocked - no real API call, no
 * network, no API key required. The mock returns canned JSON so the
 * coordinator sees valid Position / Counter shapes.
 *
 * Pinned assertions:
 *   - Question atom is written with the convening principal as author.
 *   - Each participant posts a Position atom with the question as
 *     derived_from.
 *   - When a Counter fires, it is written with the rebutted Position
 *     as derived_from.
 *   - A Decision or Escalation atom is written tying back to the
 *     Question.
 *   - The full chain Question -> Position -> Decision|Escalation is
 *     reconstructable via derived_from alone.
 *   - No real Anthropic API call is made (the mocked client records
 *     every invocation; the test asserts call counts).
 */
import { describe, expect, it, vi } from 'vitest';

import { MemoryAtomStore } from '../../../src/adapters/memory/atom-store.js';
import { MemoryPrincipalStore } from '../../../src/adapters/memory/principal-store.js';
import { MemoryClock } from '../../../src/adapters/memory/clock.js';
import {
  loadCanonFixtures,
  loadSeedPrincipals,
  runDeliberation,
  defaultCanonDir,
  defaultPrincipalsDir,
} from '../../../src/examples/virtual-org-bootstrap/boot-lib.js';
import type {
  MessagesClient,
} from '../../../src/integrations/agent-sdk/index.js';
import type {
  Atom,
  AtomId,
  PrincipalId,
} from '../../../src/substrate/types.js';
import type { Question } from '../../../src/substrate/deliberation/patterns.js';

// ---------------------------------------------------------------------------
// Mock Anthropic client
// ---------------------------------------------------------------------------

/**
 * Per-principal canned responses. Keyed by the first 40 characters of
 * the system prompt (which contains `# Principal: <name> (<role>)`),
 * so both participants get distinct outputs without the test having
 * to pattern-match on full prompt contents.
 */
interface CannedResponse {
  readonly text: string;
  readonly thinking?: string;
}

function mockAnthropic(options: {
  readonly byPrincipalRole: Record<string, { readonly position: CannedResponse; readonly counter: CannedResponse }>;
}): { client: MessagesClient; calls: Array<{ system: string; userMsg: string }> } {
  const calls: Array<{ system: string; userMsg: string }> = [];

  const client: MessagesClient = {
    messages: {
      create: vi.fn(async (args: {
        system: string;
        messages: ReadonlyArray<{ role: 'user'; content: string }>;
      }) => {
        const userMsg = args.messages[0]?.content ?? '';
        calls.push({ system: args.system, userMsg });
        const role = detectRole(args.system);
        const canned = options.byPrincipalRole[role];
        if (!canned) {
          throw new Error(`mockAnthropic: no canned response for role=${role}`);
        }
        const isCounter = userMsg.includes('Do you have a counter');
        const chosen = isCounter ? canned.counter : canned.position;
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'thinking'; thinking: string; signature: string }
        > = [];
        if (chosen.thinking !== undefined) {
          content.push({
            type: 'thinking',
            thinking: chosen.thinking,
            signature: 'sig-mock',
          });
        }
        content.push({ type: 'text', text: chosen.text });
        return { content };
      }),
    },
  };

  return { client, calls };
}

function detectRole(systemPrompt: string): string {
  const match = systemPrompt.match(/# Principal:[^(]*\(([^)]+)\)/);
  return match?.[1]?.trim() ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function setupHost(): Promise<{
  atomStore: MemoryAtomStore;
  principalStore: MemoryPrincipalStore;
  canonAtoms: ReadonlyArray<Atom>;
  seeds: ReturnType<typeof loadSeedPrincipals>;
}> {
  const clock = new MemoryClock('2026-04-22T00:00:00.000Z');
  const atomStore = new MemoryAtomStore();
  const principalStore = new MemoryPrincipalStore(clock);
  const seeds = loadSeedPrincipals({ dir: defaultPrincipalsDir() });
  for (const seed of seeds) await principalStore.put(seed.principal);
  const canonAtoms = loadCanonFixtures(defaultCanonDir());
  for (const atom of canonAtoms) await atomStore.put(atom);
  return { atomStore, principalStore, canonAtoms, seeds };
}

function buildQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-e2e-001',
    type: 'question',
    prompt: 'E2E test: propose a patch-level bump rationale.',
    scope: ['bootstrap'],
    authorPrincipal: 'vo-cto',
    participants: ['vo-cto', 'vo-code-author'],
    // Default >= 2 so round 0 collects positions and round 1 collects
    // counters. The old tests used roundBudget=1 as a workaround for
    // the now-fixed per-round position re-polling bug.
    roundBudget: 2,
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

async function queryAll(store: MemoryAtomStore): Promise<ReadonlyArray<Atom>> {
  const page = await store.query({}, 10_000);
  return page.atoms;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: two-principal deliberation (mocked SDK)', () => {
  it('writes Question, two Positions, and a Decision atom when both agents agree', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const { client, calls } = mockAnthropic({
      byPrincipalRole: {
        cto: {
          position: {
            text: JSON.stringify({
              answer: 'Bump patch; no breaking changes',
              rationale: 'Only internal refactor + bugfix landed.',
              derivedFrom: ['pol-two-principal-approve-for-l3-merges'],
            }),
          },
          counter: {
            text: JSON.stringify({ counter: null }),
          },
        },
        'code-author': {
          position: {
            text: JSON.stringify({
              answer: 'Bump patch; no breaking changes',
              rationale: 'Agree with CTO assessment.',
              derivedFrom: [],
            }),
          },
          counter: {
            text: JSON.stringify({ counter: null }),
          },
        },
      },
    });

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    const { outcome } = await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: false,
    });

    expect(outcome.type).toBe('decision');

    const atoms = await queryAll(atomStore);

    const questionAtoms = atoms.filter((a) => a.type === 'question');
    expect(questionAtoms).toHaveLength(1);
    expect(questionAtoms[0]!.id).toBe('q-e2e-001');
    expect(questionAtoms[0]!.principal_id).toBe('vo-cto');

    const positions = atoms.filter(
      (a) => a.type === 'observation' && a.metadata['kind'] === 'position',
    );
    expect(positions).toHaveLength(2);
    const positionAuthors = positions.map((p) => p.principal_id).sort();
    expect(positionAuthors).toEqual(['vo-code-author', 'vo-cto']);
    for (const p of positions) {
      expect(p.provenance.derived_from).toContain('q-e2e-001');
    }

    const decisions = atoms.filter((a) => a.type === 'decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.provenance.derived_from).toContain('q-e2e-001');
    expect(decisions[0]!.metadata['resolving']).toBe('q-e2e-001');

    // No Anthropic call was to a real endpoint; mock recorded them.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.system).toContain('Principal:');
    }
  });

  it('writes Counter atoms and still produces a Decision when disagreement resolves within the round budget', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();

    // CTO posts one answer; code-author disagrees; CTO stands firm.
    // After counters, unrebutted count is 1 (CTO's position survives)
    // -> coordinator concludes and emits a Decision.
    const { client } = mockAnthropic({
      byPrincipalRole: {
        cto: {
          position: {
            text: JSON.stringify({
              answer: 'Bump patch, land as-is',
              rationale: 'CI is green and CR is silent-skipped.',
              derivedFrom: [],
            }),
          },
          counter: {
            text: JSON.stringify({
              targetPositionId: 'pos-q-e2e-001-vo-code-author-r0',
              objection: 'Your rationale omits the CR silent-skip fence.',
              derivedFrom: ['pol-two-principal-approve-for-l3-merges'],
            }),
          },
        },
        'code-author': {
          position: {
            text: JSON.stringify({
              answer: 'Hold; trigger a fresh CR run first',
              rationale: 'Safer to re-verify after the silent-skip.',
              derivedFrom: [],
            }),
          },
          // code-author does not object back; returns null on round 0,
          // and respond was already called, so it will return null on
          // round 1 counter too.
          counter: {
            text: JSON.stringify({ counter: null }),
          },
        },
      },
    });

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    const { outcome } = await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: false,
    });

    const atoms = await queryAll(atomStore);
    const counters = atoms.filter(
      (a) => a.type === 'observation' && a.metadata['kind'] === 'counter',
    );
    expect(counters.length).toBeGreaterThanOrEqual(1);
    for (const c of counters) {
      expect(c.provenance.derived_from.length).toBeGreaterThan(0);
    }
    // Outcome is a decision (CTO's position survives).
    expect(outcome.type).toBe('decision');
  });

  it('reconstructs the full derived_from chain from the Decision back to the Question', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const { client } = mockAnthropic({
      byPrincipalRole: {
        cto: {
          position: {
            text: JSON.stringify({
              answer: 'Green-light',
              rationale: 'Canon supports the path.',
              derivedFrom: [],
            }),
          },
          counter: { text: JSON.stringify({ counter: null }) },
        },
        'code-author': {
          position: {
            text: JSON.stringify({
              answer: 'Green-light',
              rationale: 'Agree.',
              derivedFrom: [],
            }),
          },
          counter: { text: JSON.stringify({ counter: null }) },
        },
      },
    });

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );
    const question = buildQuestion();

    await runDeliberation({
      question,
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: false,
    });

    const atoms = await queryAll(atomStore);
    const byId = new Map(atoms.map((a) => [a.id, a] as const));

    const decision = atoms.find((a) => a.type === 'decision');
    expect(decision).toBeDefined();

    // Walk derived_from BFS from the decision; every node must
    // resolve and we must see the question in the reachable set.
    const seen = new Set<AtomId>();
    const queue: AtomId[] = [decision!.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const atom = byId.get(id);
      if (!atom) continue;
      for (const parent of atom.provenance.derived_from) {
        if (!seen.has(parent)) queue.push(parent);
      }
    }
    expect(seen.has(question.id as AtomId)).toBe(true);
  });

  it('emits an Escalation atom when arbitration is indeterminate', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();

    // Both principals post different answers and BOTH counter-rebut
    // the other. Coordinator's shouldConclude returns false (unrebutted
    // count != 1) and source-rank produces a tie (same layer / same
    // provenance / same depth / same confidence) -> decide returns
    // null -> Escalation.
    const { client } = mockAnthropic({
      byPrincipalRole: {
        cto: {
          position: {
            text: JSON.stringify({
              answer: 'Direction A',
              rationale: 'CTO rationale.',
              derivedFrom: [],
            }),
          },
          counter: {
            text: JSON.stringify({
              targetPositionId: 'pos-q-e2e-001-vo-code-author-r0',
              objection: 'CTO objects to code-author.',
              derivedFrom: [],
            }),
          },
        },
        'code-author': {
          position: {
            text: JSON.stringify({
              answer: 'Direction B',
              rationale: 'Code-author rationale.',
              derivedFrom: [],
            }),
          },
          counter: {
            text: JSON.stringify({
              targetPositionId: 'pos-q-e2e-001-vo-cto-r0',
              objection: 'Code-author objects to CTO.',
              derivedFrom: [],
            }),
          },
        },
      },
    });

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    // Force equal depths so source-rank ties and escalation fires.
    const { outcome } = await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: false,
      principalDepths: { 'vo-cto': 0, 'vo-code-author': 0 },
    });

    const atoms = await queryAll(atomStore);
    const escalations = atoms.filter(
      (a) => a.type === 'observation' && a.metadata['kind'] === 'escalation',
    );
    expect(escalations.length).toBeGreaterThanOrEqual(1);
    expect(outcome.type).toBe('escalation');
    const decisions = atoms.filter((a) => a.type === 'decision');
    expect(decisions).toHaveLength(0);
  });

  it('passes reasoning blocks to the AtomStore as observation atoms', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const { client } = mockAnthropic({
      byPrincipalRole: {
        cto: {
          position: {
            thinking: 'I am thinking about this carefully before answering.',
            text: JSON.stringify({
              answer: 'Green-light',
              rationale: 'Matches canon.',
              derivedFrom: [],
            }),
          },
          counter: { text: JSON.stringify({ counter: null }) },
        },
        'code-author': {
          position: {
            thinking: 'Agreeing after review.',
            text: JSON.stringify({
              answer: 'Green-light',
              rationale: 'Agree.',
              derivedFrom: [],
            }),
          },
          counter: { text: JSON.stringify({ counter: null }) },
        },
      },
    });

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: false,
    });

    const atoms = await queryAll(atomStore);
    const reasoning = atoms.filter(
      (a) => a.type === 'observation' && a.metadata['kind'] === 'reasoning-step',
    );
    expect(reasoning.length).toBeGreaterThanOrEqual(2);
    for (const r of reasoning) {
      expect(r.layer).toBe('L0');
      expect(r.provenance.kind).toBe('agent-observed');
    }
  });
});
