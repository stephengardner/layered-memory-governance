/**
 * Boot-lib execute wiring tests.
 *
 * `runDeliberation` used to stop once a Decision or Escalation was
 * emitted. This test suite pins the follow-on step: after a Decision,
 * the boot layer invokes `executeDecision` and records a PrOpenedAtom
 * (or ExecutionFailedAtom) chained to the Decision + Question. The
 * `execute: false` flag preserves the old deliberate-only behaviour
 * for test fixtures that don't want to mock a code-author call.
 *
 * Under test:
 *   - default execute: true wires a Decision through executeDecision.
 *   - execute: false short-circuits (preserves pre-PR behaviour).
 *   - An Escalation outcome never triggers execution.
 *   - Injected codeAuthorFn replaces the real runCodeAuthor.
 */
import { describe, expect, it, vi } from 'vitest';

import { MemoryAtomStore } from '../../../src/adapters/memory/atom-store.js';
import { MemoryPrincipalStore } from '../../../src/adapters/memory/principal-store.js';
import { MemoryClock } from '../../../src/adapters/memory/clock.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  loadCanonFixtures,
  loadSeedPrincipals,
  runDeliberation,
  defaultCanonDir,
  defaultPrincipalsDir,
} from '../../../src/examples/virtual-org-bootstrap/boot-lib.js';
import type { MessagesClient } from '../../../src/integrations/agent-sdk/index.js';
import type { Question } from '../../../src/substrate/deliberation/patterns.js';
import type { Atom } from '../../../src/substrate/types.js';

// ---------------------------------------------------------------------------
// Mock Anthropic client (reuses pattern from e2e.test.ts)
// ---------------------------------------------------------------------------

interface CannedResponse {
  readonly text: string;
}

function mockAnthropic(options: {
  readonly byPrincipalRole: Record<string, { readonly position: CannedResponse; readonly counter: CannedResponse }>;
}): { client: MessagesClient } {
  const client: MessagesClient = {
    messages: {
      create: vi.fn(async (args: {
        system: string;
        messages: ReadonlyArray<{ role: 'user'; content: string }>;
      }) => {
        const userMsg = args.messages[0]?.content ?? '';
        const role = detectRole(args.system);
        const canned = options.byPrincipalRole[role];
        if (!canned) throw new Error(`no canned for role=${role}`);
        const isCounter = userMsg.includes('Do you have a counter');
        const chosen = isCounter ? canned.counter : canned.position;
        return { content: [{ type: 'text', text: chosen.text }] };
      }),
    },
  };
  return { client };
}

function detectRole(systemPrompt: string): string {
  const match = systemPrompt.match(/# Principal:[^(]*\(([^)]+)\)/);
  return match?.[1]?.trim() ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Fixtures
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
    id: 'q-exec-001',
    type: 'question',
    prompt: 'Add version bump rationale.',
    scope: ['bootstrap'],
    authorPrincipal: 'vo-cto',
    participants: ['vo-cto', 'vo-code-author'],
    roundBudget: 2,
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function bothAgree(): MessagesClient {
  const { client } = mockAnthropic({
    byPrincipalRole: {
      cto: {
        position: {
          text: JSON.stringify({
            answer: 'Bump patch.',
            rationale: 'Agree.',
            derivedFrom: [],
          }),
        },
        counter: { text: JSON.stringify({ counter: null }) },
      },
      'code-author': {
        position: {
          text: JSON.stringify({
            answer: 'Bump patch.',
            rationale: 'Agree.',
            derivedFrom: [],
          }),
        },
        counter: { text: JSON.stringify({ counter: null }) },
      },
    },
  });
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDeliberation execute wiring', () => {
  it('default execute: true calls codeAuthorFn after a Decision is emitted', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();

    const codeAuthorFn = vi.fn(async () => ({
      kind: 'dispatched' as const,
      summary: 'code-author dispatched plan X as PR #4242 (deadbee)',
    }));

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    const result = await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: true,
      executorPrincipalId: 'vo-code-author',
      host: createMemoryHost(),
      codeAuthorFn,
    });

    expect(result.outcome.type).toBe('decision');
    expect(result.execution).toBeDefined();
    expect(result.execution!.kind).toBe('pr-opened');
    expect(codeAuthorFn).toHaveBeenCalledTimes(1);
  });

  it('execute: false preserves the pre-executor behaviour (no codeAuthorFn call)', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();

    const codeAuthorFn = vi.fn();

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    const result = await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: false,
      codeAuthorFn,
    });

    expect(result.outcome.type).toBe('decision');
    expect(result.execution).toBeUndefined();
    expect(codeAuthorFn).not.toHaveBeenCalled();
  });

  it('an Escalation outcome never triggers execution', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    // Disagreement + counter-rebuttal -> escalation.
    const { client } = mockAnthropic({
      byPrincipalRole: {
        cto: {
          position: {
            text: JSON.stringify({
              answer: 'A',
              rationale: 'r1',
              derivedFrom: [],
            }),
          },
          counter: {
            text: JSON.stringify({
              targetPositionId: 'pos-q-exec-001-vo-code-author-r0',
              objection: 'no',
              derivedFrom: [],
            }),
          },
        },
        'code-author': {
          position: {
            text: JSON.stringify({
              answer: 'B',
              rationale: 'r2',
              derivedFrom: [],
            }),
          },
          counter: {
            text: JSON.stringify({
              targetPositionId: 'pos-q-exec-001-vo-cto-r0',
              objection: 'no',
              derivedFrom: [],
            }),
          },
        },
      },
    });

    const codeAuthorFn = vi.fn();

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    const result = await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: true,
      executorPrincipalId: 'vo-code-author',
      host: createMemoryHost(),
      codeAuthorFn,
      principalDepths: { 'vo-cto': 0, 'vo-code-author': 0 },
    });

    expect(result.outcome.type).toBe('escalation');
    expect(result.execution).toBeUndefined();
    expect(codeAuthorFn).not.toHaveBeenCalled();
  });

  it('persists the PrOpenedAtom to the atom store via the existing sink pathway', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();

    const codeAuthorFn = vi.fn(async () => ({
      kind: 'dispatched' as const,
      summary: 'code-author dispatched plan X as PR #7 (c0ffee0)',
    }));

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
      execute: true,
      executorPrincipalId: 'vo-code-author',
      host: createMemoryHost(),
      codeAuthorFn,
    });

    const page = await atomStore.query({}, 10_000);
    const prOpened = page.atoms.filter(
      (a) => a.type === 'observation' && a.metadata?.['kind'] === 'pr-opened',
    );
    expect(prOpened).toHaveLength(1);
    expect(prOpened[0]!.principal_id).toBe('vo-code-author');
    const parents = prOpened[0]!.provenance.derived_from;
    expect(parents).toContain('q-exec-001');
  });

  // -------------------------------------------------------------------------
  // Regression tests for CR #106 findings:
  //   - Finding 1 (PRRT_kwDOSGhm98589guF): JSDoc promised
  //     `executorPrincipalId` is required when `execute` is not false,
  //     but the implementation silently defaulted to 'vo-code-author'.
  //     A caller in a non-virtual-org deployment who forgot the field
  //     would attribute PRs to a principal that doesn't exist in their
  //     PrincipalStore. Fix: fail fast with a clear error.
  //   - Finding 2 (PRRT_kwDOSGhm98589guJ): `as unknown as Host`
  //     fabricated a partial Host with only `atoms` + `principals`. The
  //     default `runCodeAuthor` path touches notifier/scheduler/clock/
  //     auditor/llm/canon and would NPE on the partial. Fix: require
  //     the caller to pass a real Host; drop the cast.
  // -------------------------------------------------------------------------
  it('regression CR#106 finding 1: throws when execute !== false and executorPrincipalId is omitted', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();

    const codeAuthorFn = vi.fn(async () => ({
      kind: 'dispatched' as const,
      summary: 'should-not-be-called',
    }));

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    await expect(
      runDeliberation({
        question: buildQuestion(),
        participants: participating,
        atomStore,
        principalStore,
        anthropic: client,
        canonAtoms,
        decidingPrincipal: 'vo-cto',
        execute: true,
        // executorPrincipalId intentionally omitted.
        host: createMemoryHost(),
        codeAuthorFn,
      }),
    ).rejects.toThrow(/executorPrincipalId/);
    expect(codeAuthorFn).not.toHaveBeenCalled();
  });

  it('regression CR#106 finding 1: also throws when execute is undefined (defaults to true)', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    await expect(
      runDeliberation({
        question: buildQuestion(),
        participants: participating,
        atomStore,
        principalStore,
        anthropic: client,
        canonAtoms,
        decidingPrincipal: 'vo-cto',
        // execute + executorPrincipalId both omitted; execute defaults to true.
        host: createMemoryHost(),
      }),
    ).rejects.toThrow(/executorPrincipalId/);
  });

  it('regression CR#106 finding 1: does NOT throw when execute is false and executorPrincipalId is omitted', async () => {
    // executorPrincipalId is only required when execution is on;
    // deliberate-only callers should still be able to omit it.
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    const result = await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: false,
    });

    expect(result.outcome.type).toBe('decision');
    expect(result.execution).toBeUndefined();
  });

  it('regression CR#106 finding 2: throws when execute !== false and host is omitted', async () => {
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();

    const codeAuthorFn = vi.fn(async () => ({
      kind: 'dispatched' as const,
      summary: 'should-not-be-called',
    }));

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    await expect(
      runDeliberation({
        question: buildQuestion(),
        participants: participating,
        atomStore,
        principalStore,
        anthropic: client,
        canonAtoms,
        decidingPrincipal: 'vo-cto',
        execute: true,
        executorPrincipalId: 'vo-code-author',
        // host intentionally omitted.
        codeAuthorFn,
      }),
    ).rejects.toThrow(/host/);
    expect(codeAuthorFn).not.toHaveBeenCalled();
  });

  it('regression CR#106 finding 2: does NOT throw when execute is false and host is omitted', async () => {
    // When the caller opted out of execution there is no Host touch-path,
    // so host should remain optional; only execute=true should gate on it.
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();

    const participating = seeds.filter(
      (s) => s.principal.id === 'vo-cto' || s.principal.id === 'vo-code-author',
    );

    const result = await runDeliberation({
      question: buildQuestion(),
      participants: participating,
      atomStore,
      principalStore,
      anthropic: client,
      canonAtoms,
      decidingPrincipal: 'vo-cto',
      execute: false,
    });

    expect(result.outcome.type).toBe('decision');
    expect(result.execution).toBeUndefined();
  });

  it('regression CR#106 finding 2: passes the caller-supplied Host through to executeDecision (no partial-Host cast)', async () => {
    // Pin the integration contract: the Host the caller supplies is the
    // same object executeDecision receives. Guards against any future
    // regression that fabricates a partial Host from (atomStore,
    // principalStore) instead of threading opts.host through verbatim.
    const { atomStore, principalStore, canonAtoms, seeds } = await setupHost();
    const client = bothAgree();
    const operatorHost = createMemoryHost();

    let receivedHost: unknown = null;
    const codeAuthorFn = vi.fn(async (host: unknown) => {
      receivedHost = host;
      return {
        kind: 'dispatched' as const,
        summary: 'code-author dispatched plan X as PR #1 (aaaa111)',
      };
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
      execute: true,
      executorPrincipalId: 'vo-code-author',
      host: operatorHost,
      codeAuthorFn,
    });

    expect(receivedHost).toBe(operatorHost);
    // Sanity: the threaded Host exposes all 8 sub-interfaces, not a
    // partial-Host cast. A regression to the cast would leave these
    // undefined.
    const host = receivedHost as Record<string, unknown>;
    expect(host['atoms']).toBeDefined();
    expect(host['canon']).toBeDefined();
    expect(host['llm']).toBeDefined();
    expect(host['notifier']).toBeDefined();
    expect(host['scheduler']).toBeDefined();
    expect(host['auditor']).toBeDefined();
    expect(host['principals']).toBeDefined();
    expect(host['clock']).toBeDefined();
  });
});
