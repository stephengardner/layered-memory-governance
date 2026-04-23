/**
 * Decision -> runCodeAuthor executor handoff tests.
 *
 * `executeDecision` is the thin adapter between the virtual-org
 * deliberation output (a Decision atom) and the `runCodeAuthor`
 * sub-actor invoker. It takes a Decision + the originating Question
 * and returns either a `PrOpenedAtom` (on successful PR creation) or
 * an `ExecutionFailedAtom` (on any failure mode). Failures are
 * captured as atoms, NOT thrown, so the governance layer can
 * preserve the provenance chain through a failed execution.
 *
 * The `codeAuthorFn` is injectable so these tests never call the
 * real `runCodeAuthor` (which requires a plan atom in executing
 * state + a live code-author fence + a git-authed host). The tests
 * mock the fn and verify only the Decision -> atom-shape mapping.
 */

import { describe, expect, it, vi } from 'vitest';

import { MemoryAtomStore } from '../../../src/adapters/memory/atom-store.js';
import { MemoryPrincipalStore } from '../../../src/adapters/memory/principal-store.js';
import { MemoryClock } from '../../../src/adapters/memory/clock.js';
import { MemoryCanonStore } from '../../../src/adapters/memory/canon-store.js';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { Host } from '../../../src/substrate/interface.js';
import type {
  Decision,
  Question,
} from '../../../src/substrate/deliberation/patterns.js';
import {
  executeDecision,
  type PrOpenedAtom,
  type ExecutionFailedAtom,
} from '../../../src/integrations/agent-sdk/executor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-decision-executor-001',
    type: 'question',
    prompt: 'Add a CHANGELOG entry for v0.1.1.',
    scope: ['bootstrap'],
    authorPrincipal: 'vo-cto',
    participants: ['vo-cto', 'vo-code-author'],
    roundBudget: 2,
    timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    created_at: '2026-04-21T00:00:00.000Z',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'd-q-decision-executor-001',
    type: 'decision',
    resolving: 'q-decision-executor-001',
    answer: 'Bump patch version; add "Bugfixes" section to CHANGELOG.',
    arbitrationTrace: 'Both principals agreed on patch bump rationale.',
    authorPrincipal: 'vo-cto',
    created_at: '2026-04-21T00:00:05.000Z',
    ...overrides,
  };
}

function makeHost(): Host {
  return createMemoryHost();
}

// A mock codeAuthorFn that simulates the real runCodeAuthor return
// shape on success. Accepts a fake PR number/SHA/branch so tests can
// pin the returned atom's content.
function mockCodeAuthorSuccess(overrides: {
  prNumber?: number;
  commitSha?: string;
  branchName?: string;
} = {}): {
  fn: ReturnType<typeof vi.fn>;
  prNumber: number;
  commitSha: string;
  branchName: string;
} {
  const prNumber = overrides.prNumber ?? 9999;
  const commitSha = overrides.commitSha ?? 'abcdef1234567890abcdef1234567890abcdef12';
  const branchName = overrides.branchName ?? 'code-author/mock-decision-001';
  const fn = vi.fn(async () => ({
    kind: 'dispatched' as const,
    summary:
      `code-author dispatched plan mock as PR #${prNumber} (${commitSha.slice(0, 7)})`,
  }));
  return { fn, prNumber, commitSha, branchName };
}

function mockCodeAuthorError(message: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    kind: 'error' as const,
    message,
  }));
}

function mockCodeAuthorThrows(message: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeDecision: Decision -> runCodeAuthor handoff', () => {
  it('emits a PrOpenedAtom on successful invocation', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    const result = await executeDecision({
      decision: makeDecision(),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
    });

    expect(result.kind).toBe('pr-opened');
    expect(result.type).toBe('observation');
    const parsed = JSON.parse((result as PrOpenedAtom).content) as {
      prNumber: number;
      branchName: string;
      commitSha: string;
      url: string;
    };
    expect(parsed.prNumber).toBe(prNumber);
    expect(parsed.branchName).toBe(branchName);
    expect(parsed.commitSha).toBe(commitSha);
    expect(parsed.url).toContain(`#${prNumber}`);
  });

  it('PrOpenedAtom.derivedFrom lists decision.id then question.id in that order', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    const decision = makeDecision({ id: 'd-order-check' });
    const question = makeQuestion({ id: 'q-order-check' });

    const result = (await executeDecision({
      decision,
      question,
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
    })) as PrOpenedAtom;

    expect(result.kind).toBe('pr-opened');
    expect(result.derivedFrom).toEqual(['d-order-check', 'q-order-check']);
  });

  it('emits an ExecutionFailedAtom when codeAuthorFn returns kind=error', async () => {
    const host = makeHost();
    const fn = mockCodeAuthorError('fence load failed: missing pol-code-author-budget');

    const result = await executeDecision({
      decision: makeDecision(),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
    });

    expect(result.kind).toBe('execution-failed');
    expect(result.type).toBe('observation');
    const parsed = JSON.parse((result as ExecutionFailedAtom).content) as {
      reason: string;
      stderr: string;
      stage: string;
    };
    expect(parsed.reason).toContain('fence load failed');
  });

  it('emits an ExecutionFailedAtom when codeAuthorFn throws', async () => {
    const host = makeHost();
    const fn = mockCodeAuthorThrows('network unreachable');

    const result = await executeDecision({
      decision: makeDecision(),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
    });

    expect(result.kind).toBe('execution-failed');
    const parsed = JSON.parse((result as ExecutionFailedAtom).content) as {
      reason: string;
      stderr: string;
      stage: string;
    };
    expect(parsed.reason).toContain('network unreachable');
  });

  it('principal_id on the emitted atom is executorPrincipalId, not decision.authorPrincipal', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    // Decision author = vo-cto. Executor = vo-code-author. The emitted
    // atom must carry the executor's principal; mixing the two would
    // attribute the PR to the deliberation author.
    const result = await executeDecision({
      decision: makeDecision({ authorPrincipal: 'vo-cto' }),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
    });

    expect(result.principal_id).toBe('vo-code-author');
  });

  it('fires onPrOpened on success', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();
    const onPrOpened = vi.fn<(atom: PrOpenedAtom) => void>();

    await executeDecision({
      decision: makeDecision(),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
      onPrOpened,
    });

    expect(onPrOpened).toHaveBeenCalledTimes(1);
    const atom = onPrOpened.mock.calls[0]![0];
    expect(atom.kind).toBe('pr-opened');
  });

  it('does NOT fire onPrOpened on failure', async () => {
    const host = makeHost();
    const fn = mockCodeAuthorError('fence missing');
    const onPrOpened = vi.fn<(atom: PrOpenedAtom) => void>();

    await executeDecision({
      decision: makeDecision(),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      onPrOpened,
    });

    expect(onPrOpened).not.toHaveBeenCalled();
  });

  it('invokes codeAuthorFn exactly once per call', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    await executeDecision({
      decision: makeDecision(),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ExecutionFailedAtom.derivedFrom has same [decision.id, question.id] ordering as success path', async () => {
    const host = makeHost();
    const fn = mockCodeAuthorError('something broke');

    const result = (await executeDecision({
      decision: makeDecision({ id: 'd-fail-order' }),
      question: makeQuestion({ id: 'q-fail-order' }),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
    })) as ExecutionFailedAtom;

    expect(result.derivedFrom).toEqual(['d-fail-order', 'q-fail-order']);
  });

  it('produces a valid atom id on success (non-empty, stable shape)', async () => {
    const host = makeHost();
    const { fn, prNumber, commitSha, branchName } = mockCodeAuthorSuccess();

    const result = await executeDecision({
      decision: makeDecision({ id: 'd-id-shape' }),
      question: makeQuestion(),
      executorPrincipalId: 'vo-code-author',
      host,
      codeAuthorFn: fn,
      prResolver: async () => ({ prNumber, commitSha, branchName }),
    });

    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.id).toContain('d-id-shape');
  });
});
