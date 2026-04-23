/**
 * Agent SDK agent-process.
 *
 * `startAgent` composes a per-principal system prompt from a canon
 * renderer, then exposes `respondTo` and `counterOnce` which call the
 * Anthropic SDK and return deliberation patterns (Position, Counter).
 *
 * These tests pin down:
 *   - startAgent calls the canonRenderer.renderFor to build the system
 *     prompt with the correct principal.
 *   - respondTo sends the question prompt and returns a valid Position
 *     with the principal as author.
 *   - respondTo persists any thinking blocks via the reasoningSink
 *     callback when provided.
 *   - counterOnce returns null when no other principal has posted.
 *   - counterOnce returns null when the model replies with a null
 *     counter.
 *   - counterOnce returns a Counter targeting the indicated position
 *     when the model replies with one.
 *   - pause / resume / stop update the observable status.
 *   - The provided AbortSignal, when aborted, causes respondTo /
 *     counterOnce to throw.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../../src/substrate/types.js';
import { startAgent } from '../../../src/integrations/agent-sdk/agent-process.js';
import {
  validateCounter,
  validatePosition,
  type Position,
  type Question,
} from '../../../src/substrate/deliberation/patterns.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function fakePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: 'cto-principal' as Principal['id'],
    name: 'CTO',
    role: 'cto',
    permitted_scopes: { read: ['project'], write: ['project'] },
    permitted_layers: { read: ['L0', 'L1', 'L2', 'L3'], write: ['L1', 'L2'] },
    goals: ['uphold invariants'],
    constraints: ['no self-approval'],
    active: true,
    compromised_at: null,
    signed_by: null,
    created_at: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

function fakeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    type: 'question',
    prompt: 'How do we fix X?',
    scope: ['code'],
    authorPrincipal: 'ceo-principal',
    participants: ['cto-principal', 'code-author-principal'],
    roundBudget: 3,
    timeoutAt: '2026-04-23T00:00:00.000Z',
    created_at: '2026-04-22T00:00:00.000Z',
    ...overrides,
  };
}

interface MockMessagesCreateArgs {
  readonly model: string;
  readonly system: string;
  readonly messages: ReadonlyArray<{ role: string; content: string }>;
  readonly thinking?: { type: string; budget_tokens: number };
}

function mockAnthropic(script: Array<{
  content: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string; signature: string }>;
}>) {
  const calls: MockMessagesCreateArgs[] = [];
  let i = 0;
  const anthropic = {
    messages: {
      create: vi.fn(async (args: unknown) => {
        calls.push(args as MockMessagesCreateArgs);
        const next = script[i++];
        if (!next) throw new Error(`mock exhausted after ${i - 1} calls`);
        return next;
      }),
    },
  };
  return { anthropic, calls };
}

// A minimal renderFor that records what was requested.
function fakeCanonRenderer(body: string) {
  const calls: Array<{ principal: Principal }> = [];
  return {
    calls,
    renderFor: (args: { principal: Principal }) => {
      calls.push({ principal: args.principal });
      return body;
    },
  };
}

// ---------------------------------------------------------------------------
// startAgent wiring
// ---------------------------------------------------------------------------

describe('startAgent wiring', () => {
  it('composes a system prompt from the canon renderer for the given principal', async () => {
    const renderer = fakeCanonRenderer('CANON_BODY');
    const { anthropic, calls } = mockAnthropic([
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              answer: 'apply patch Z',
              rationale: 'because Y',
              derivedFrom: ['atom-1'],
            }),
          },
        ],
      },
    ]);

    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: renderer,
      anthropic: anthropic as never,
    });

    await agent.respondTo(fakeQuestion());

    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]!.principal.id).toBe('cto-principal');
    expect(calls[0]!.system).toContain('CANON_BODY');
  });

  it('honours a caller-supplied model override', async () => {
    const { anthropic, calls } = mockAnthropic([
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ answer: 'a', rationale: 'r' }),
          },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer('c'),
      anthropic: anthropic as never,
      model: 'claude-opus-4-7',
    });
    await agent.respondTo(fakeQuestion());
    expect(calls[0]!.model).toBe('claude-opus-4-7');
  });

  it('exposes the principal id on the handle', () => {
    const { anthropic } = mockAnthropic([]);
    const agent = startAgent({
      principal: fakePrincipal({ id: 'vo-cto' as Principal['id'] }),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    expect(agent.id).toBe('vo-cto');
  });
});

// ---------------------------------------------------------------------------
// respondTo
// ---------------------------------------------------------------------------

describe('respondTo', () => {
  it('returns a valid Position authored by the principal', async () => {
    const { anthropic } = mockAnthropic([
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              answer: 'bump patch',
              rationale: 'no functional change',
              derivedFrom: ['atom-x'],
            }),
          },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });

    const pos = await agent.respondTo(fakeQuestion({ id: 'q-abc' }));

    expect(() => validatePosition(pos)).not.toThrow();
    expect(pos.type).toBe('position');
    expect(pos.authorPrincipal).toBe('cto-principal');
    expect(pos.inResponseTo).toBe('q-abc');
    expect(pos.answer).toBe('bump patch');
    expect(pos.rationale).toBe('no functional change');
    expect(pos.derivedFrom).toEqual(['atom-x']);
  });

  it('sends the question prompt in the user message', async () => {
    const { anthropic, calls } = mockAnthropic([
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ answer: 'a', rationale: 'r' }),
          },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    await agent.respondTo(fakeQuestion({ prompt: 'PROMPT-XYZ' }));
    const userMsg = calls[0]!.messages[0]!;
    expect(userMsg.role).toBe('user');
    expect(userMsg.content).toContain('PROMPT-XYZ');
  });

  it('enables extended thinking in the SDK call', async () => {
    const { anthropic, calls } = mockAnthropic([
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ answer: 'a', rationale: 'r' }),
          },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    await agent.respondTo(fakeQuestion());
    expect(calls[0]!.thinking?.type).toBe('enabled');
    expect((calls[0]!.thinking?.budget_tokens ?? 0)).toBeGreaterThanOrEqual(1024);
  });

  it('sends thinking.budget_tokens STRICTLY LESS than max_tokens (CR #105)', async () => {
    // CR finding PRRT_kwDOSGhm98588lGc: the Anthropic Messages API
    // rejects requests where thinking.budget_tokens >= max_tokens with
    // a 400. Our previous defaults (max=4096, budget=8192) violated
    // this invariant on every call; the SDK backend was broken on
    // day one for anyone setting LAG_LLM_BACKEND=sdk.
    const { anthropic, calls } = mockAnthropic([
      {
        content: [
          { type: 'text', text: JSON.stringify({ answer: 'a', rationale: 'r' }) },
        ],
      },
      {
        content: [
          { type: 'text', text: JSON.stringify({ counter: null }) },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    // Default path (no maxTokens / thinkingBudgetTokens overrides).
    await agent.respondTo(fakeQuestion());
    await agent.counterOnce([{
      id: 'p-other',
      type: 'position',
      inResponseTo: 'q1',
      answer: 'other',
      rationale: 'other',
      derivedFrom: [],
      authorPrincipal: 'code-author-principal',
      created_at: '2026-04-22T00:00:00.000Z',
    }]);
    // Both respondTo and counterOnce must satisfy budget < max.
    for (const c of calls) {
      const budget = c.thinking?.budget_tokens ?? 0;
      expect(budget, `budget ${budget} must be < max ${c['max_tokens']}`)
        .toBeLessThan((c as unknown as { max_tokens: number }).max_tokens);
    }
  });

  it('rejects synchronously when options set thinkingBudget >= maxTokens (CR #105)', () => {
    // Callers passing explicit overrides must get a clear error at
    // construction time, not a 400 from Anthropic half-way through
    // a deliberation. Fail loudly up-front.
    const { anthropic } = mockAnthropic([]);
    expect(() =>
      startAgent({
        principal: fakePrincipal(),
        canonRenderer: fakeCanonRenderer(''),
        anthropic: anthropic as never,
        maxTokens: 4096,
        thinkingBudgetTokens: 4096, // equal to max: invalid
      }),
    ).toThrow(/thinking.*(budget|max)/i);
    expect(() =>
      startAgent({
        principal: fakePrincipal(),
        canonRenderer: fakeCanonRenderer(''),
        anthropic: anthropic as never,
        maxTokens: 4096,
        thinkingBudgetTokens: 8192, // greater than max: invalid
      }),
    ).toThrow(/thinking.*(budget|max)/i);
  });

  it('delivers thinking blocks to the reasoningSink', async () => {
    const sink = vi.fn();
    const { anthropic } = mockAnthropic([
      {
        content: [
          { type: 'thinking', thinking: 'step A', signature: 'sig-a' },
          { type: 'thinking', thinking: 'step B', signature: 'sig-b' },
          {
            type: 'text',
            text: JSON.stringify({ answer: 'a', rationale: 'r' }),
          },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
      reasoningSink: sink,
    });

    await agent.respondTo(fakeQuestion({ id: 'q-thinking' }));

    expect(sink).toHaveBeenCalledTimes(2);
    const [first, second] = sink.mock.calls;
    expect(first![0].thinking).toBe('step A');
    expect(first![0].principalId).toBe('cto-principal');
    expect(first![0].questionId).toBe('q-thinking');
    expect(second![0].thinking).toBe('step B');
  });

  it('extracts JSON even when wrapped in markdown code fences', async () => {
    const { anthropic } = mockAnthropic([
      {
        content: [
          {
            type: 'text',
            text: '```json\n' + JSON.stringify({ answer: 'a', rationale: 'r' }) + '\n```',
          },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    const pos = await agent.respondTo(fakeQuestion());
    expect(pos.answer).toBe('a');
  });

  it('throws when the response has no text block', async () => {
    const { anthropic } = mockAnthropic([
      {
        content: [{ type: 'thinking', thinking: 't', signature: 's' }],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    await expect(agent.respondTo(fakeQuestion())).rejects.toThrow(/text/i);
  });

  it('rejects when the provided AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { anthropic } = mockAnthropic([]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
      signal: controller.signal,
    });
    await expect(agent.respondTo(fakeQuestion())).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// counterOnce
// ---------------------------------------------------------------------------

describe('counterOnce', () => {
  function samplePosition(overrides: Partial<Position> = {}): Position {
    return {
      id: 'p-from-other',
      type: 'position',
      inResponseTo: 'q1',
      answer: 'other answer',
      rationale: 'other rationale',
      derivedFrom: [],
      authorPrincipal: 'code-author-principal',
      created_at: '2026-04-22T00:00:00.000Z',
      ...overrides,
    };
  }

  it('returns null when every position is authored by this principal', async () => {
    const { anthropic, calls } = mockAnthropic([]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    const result = await agent.counterOnce([
      samplePosition({ id: 'p-self', authorPrincipal: 'cto-principal' }),
    ]);
    expect(result).toBeNull();
    // Must not have called the SDK when there was nothing to counter.
    expect(calls).toHaveLength(0);
  });

  it('returns null when the model replies with { counter: null }', async () => {
    const { anthropic } = mockAnthropic([
      {
        content: [
          { type: 'text', text: JSON.stringify({ counter: null }) },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    const result = await agent.counterOnce([samplePosition()]);
    expect(result).toBeNull();
  });

  it('returns a valid Counter when the model selects a targetPositionId', async () => {
    const { anthropic } = mockAnthropic([
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              targetPositionId: 'p-from-other',
              objection: 'breaks invariant X',
              derivedFrom: ['atom-y'],
            }),
          },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    const result = await agent.counterOnce([samplePosition()]);
    expect(result).not.toBeNull();
    expect(() => validateCounter(result!)).not.toThrow();
    expect(result!.type).toBe('counter');
    expect(result!.inResponseTo).toBe('p-from-other');
    expect(result!.objection).toBe('breaks invariant X');
    expect(result!.authorPrincipal).toBe('cto-principal');
    expect(result!.derivedFrom).toEqual(['atom-y']);
  });

  it('sends the other-principal positions (not self-authored) to the model', async () => {
    const { anthropic, calls } = mockAnthropic([
      {
        content: [
          { type: 'text', text: JSON.stringify({ counter: null }) },
        ],
      },
    ]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    await agent.counterOnce([
      samplePosition({
        id: 'p-self',
        authorPrincipal: 'cto-principal',
        answer: 'self answer',
      }),
      samplePosition({
        id: 'p-external',
        authorPrincipal: 'code-author-principal',
        answer: 'external answer',
      }),
    ]);
    const userContent = calls[0]!.messages[0]!.content;
    // External position present, self position absent.
    expect(userContent).toContain('external answer');
    expect(userContent).not.toContain('self answer');
  });

  it('rejects when the provided AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { anthropic } = mockAnthropic([]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
      signal: controller.signal,
    });
    await expect(
      agent.counterOnce([{
        id: 'p1',
        type: 'position',
        inResponseTo: 'q1',
        answer: 'a',
        rationale: 'r',
        derivedFrom: [],
        authorPrincipal: 'code-author-principal',
        created_at: '2026-04-22T00:00:00.000Z',
      }]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('AgentHandle lifecycle', () => {
  it('starts in running state', () => {
    const { anthropic } = mockAnthropic([]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    expect(agent.status()).toBe('running');
  });

  it('pause -> paused, resume -> running, stop -> stopped', () => {
    const { anthropic } = mockAnthropic([]);
    const agent = startAgent({
      principal: fakePrincipal(),
      canonRenderer: fakeCanonRenderer(''),
      anthropic: anthropic as never,
    });
    agent.pause();
    expect(agent.status()).toBe('paused');
    agent.resume();
    expect(agent.status()).toBe('running');
    agent.stop();
    expect(agent.status()).toBe('stopped');
  });
});
