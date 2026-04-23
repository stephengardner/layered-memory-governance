/**
 * Agent process: per-principal Anthropic SDK agent that participates
 * in a deliberation.
 *
 * `startAgent` builds a handle (the AgentHandle interface) that the
 * coordinator calls to collect Position atoms (`respondTo`) and optional
 * Counter atoms (`counterOnce`). Each call:
 *
 *   1. Composes the system prompt via the provided canon renderer
 *      (principal-scoped canon: L0..L3 filtered by permitted layers +
 *      role-tag filter, plus a principal header).
 *   2. Calls the Anthropic Messages API with extended thinking enabled
 *      so reasoning blocks are returned in plaintext.
 *   3. Drains any `thinking` content blocks to an optional reasoningSink
 *      callback; the caller is free to translate them into atoms.
 *   4. Parses a `text` block as JSON (tolerating markdown fences) and
 *      returns the appropriate deliberation shape.
 *
 * The integration is deliberately substrate-thin:
 *   - It does not import an AtomStore directly; the reasoningSink seam
 *     decouples "record reasoning" from "which store writes the atom".
 *     The boot script composes the two.
 *   - It accepts a caller-supplied AbortSignal for kill-switch
 *     propagation so we don't hardwire a specific KillSwitchController
 *     shape. The standard kill-switch primitive (`createKillSwitch`)
 *     already exposes a `signal`; callers pass that directly.
 *   - It does not commit to an Anthropic client concrete type; callers
 *     pass any object satisfying the minimal `MessagesClient` surface.
 *     Tests substitute a vi.fn mock; production passes `new Anthropic()`.
 *
 * A second integration (e.g. LangGraph-driven) implements the same
 * AgentHandle interface over different runtime primitives without any
 * change to the coordinator.
 */

import type { Principal } from '../../substrate/types.js';
import type {
  Counter,
  Position,
  Question,
} from '../../substrate/deliberation/patterns.js';

// ---------------------------------------------------------------------------
// Minimal SDK surface we depend on
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the Anthropic client we actually call. Typed as a
 * structural interface so tests can substitute a mock without casting
 * through the full SDK surface.
 */
export interface MessagesClient {
  readonly messages: {
    create(args: MessageCreateArgs): Promise<MessageCreateResult>;
  };
}

interface MessageCreateArgs {
  readonly model: string;
  readonly system: string;
  readonly max_tokens: number;
  readonly thinking?: { readonly type: 'enabled'; readonly budget_tokens: number };
  readonly messages: ReadonlyArray<{ readonly role: 'user'; readonly content: string }>;
}

interface MessageCreateResult {
  readonly content: ReadonlyArray<MessageContentBlock>;
}

type MessageContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: string; readonly [k: string]: unknown };

// ---------------------------------------------------------------------------
// Canon renderer seam
// ---------------------------------------------------------------------------

/**
 * Minimal contract for a canon renderer capable of producing a
 * principal-scoped system prompt. The real CanonMdManager writes to
 * disk as well; the boot script wires the disk write, but this layer
 * only needs the rendered string.
 */
export interface CanonRendererForPrincipal {
  renderFor(args: { principal: Principal }): string;
}

// ---------------------------------------------------------------------------
// Reasoning sink seam
// ---------------------------------------------------------------------------

export interface ReasoningEvent {
  readonly principalId: string;
  readonly questionId: string;
  readonly thinking: string;
  readonly signature: string;
  readonly emittedAt: string;
}

export type ReasoningSink = (event: ReasoningEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Public handle + factory
// ---------------------------------------------------------------------------

export type AgentStatus = 'running' | 'paused' | 'stopped';

export interface AgentHandle {
  readonly id: string;
  pause(): void;
  resume(): void;
  stop(): void;
  status(): AgentStatus;
  respondTo(question: Question): Promise<Position>;
  counterOnce(positions: ReadonlyArray<Position>): Promise<Counter | null>;
}

export interface StartAgentOptions {
  readonly principal: Principal;
  readonly canonRenderer: CanonRendererForPrincipal;
  readonly anthropic: MessagesClient;
  /**
   * Optional model override. Defaults to `DEFAULT_MODEL`. A principal
   * record does not carry a model in the core Principal type, so the
   * default is a property of the integration; callers mapping per-role
   * models compose one wrapper per principal.
   */
  readonly model?: string;
  /**
   * Max output tokens per request. Default 16384 for respondTo, half
   * that for counterOnce (counters are short). Override if your models
   * or prompts require more. Per the Anthropic Messages API contract,
   * max_tokens must be strictly greater than thinking.budget_tokens;
   * startAgent validates this and throws up-front on violation.
   */
  readonly maxTokens?: number;
  /**
   * Extended-thinking budget for respondTo. Default 8192. Must be
   * >= 1024 per the Anthropic API contract and < maxTokens. The
   * counterOnce path halves this budget (floored to 1024) and halves
   * max_tokens, then re-validates the strict inequality.
   */
  readonly thinkingBudgetTokens?: number;
  /**
   * Optional callback invoked once per `thinking` content block in any
   * respondTo or counterOnce response. The boot script wires this to
   * an AtomStore.put() call that synthesises a proper Atom.
   */
  readonly reasoningSink?: ReasoningSink;
  /**
   * Optional AbortSignal for kill-switch propagation. If aborted at or
   * before a respondTo/counterOnce call, the call rejects synchronously.
   * Callers typically pass `killSwitch.signal` from the substrate
   * kill-switch primitive.
   */
  readonly signal?: AbortSignal;
}

/** Default model; overridden per-principal by the caller. */
const DEFAULT_MODEL = 'claude-opus-4-7';
// Anthropic's Messages API requires `thinking.budget_tokens < max_tokens`
// for manual extended thinking, returning 400 otherwise. The previous
// defaults (max=4096, budget=8192) violated this on every call. Raising
// max well above the thinking budget keeps both respondTo (max) and
// counterOnce (floor(max/2)) strictly above their respective budgets
// (floor(budget/2), with a 1024 floor). Callers overriding either knob
// still get the runtime guard below.
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_THINKING_BUDGET = 8192;
const MIN_THINKING_BUDGET = 1024;

export function startAgent(opts: StartAgentOptions): AgentHandle {
  const systemPrompt = opts.canonRenderer.renderFor({ principal: opts.principal });
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const thinkingBudget = opts.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET;
  // Fail loudly up-front. The SDK path otherwise hits a 400 mid-round,
  // surfacing a cryptic API error the operator has to trace. Validate
  // against the Anthropic contract: budget must be < max_tokens, and
  // the counterOnce branch halves both - ensure the halved budget
  // (floored to MIN_THINKING_BUDGET) is also strictly less than the
  // halved max_tokens.
  if (thinkingBudget >= maxTokens) {
    throw new Error(
      `[agent-sdk] thinkingBudgetTokens (${thinkingBudget}) must be strictly less than maxTokens (${maxTokens}) per Anthropic API contract`,
    );
  }
  const counterMaxTokens = Math.max(1, Math.floor(maxTokens / 2));
  const counterBudget = Math.max(MIN_THINKING_BUDGET, Math.floor(thinkingBudget / 2));
  if (counterBudget >= counterMaxTokens) {
    throw new Error(
      `[agent-sdk] counter-branch thinking budget (${counterBudget}) must be < max_tokens (${counterMaxTokens}); increase maxTokens or decrease thinkingBudgetTokens`,
    );
  }
  const principalId = String(opts.principal.id);

  let state: AgentStatus = 'running';

  function assertSignalOpen(): void {
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason;
      // Preserve the reason if caller attached one (kill-switch does).
      if (reason instanceof Error) throw reason;
      throw new Error(
        `[agent-sdk] AbortSignal aborted: ${typeof reason === 'string' ? reason : 'signal aborted'}`,
      );
    }
  }

  async function drainThinking(
    blocks: ReadonlyArray<MessageContentBlock>,
    questionId: string,
  ): Promise<void> {
    if (!opts.reasoningSink) return;
    for (const block of blocks) {
      if (block.type !== 'thinking') continue;
      const thinking = (block as { thinking?: unknown }).thinking;
      const signature = (block as { signature?: unknown }).signature;
      if (typeof thinking !== 'string') continue;
      await opts.reasoningSink({
        principalId,
        questionId,
        thinking,
        signature: typeof signature === 'string' ? signature : '',
        emittedAt: new Date().toISOString(),
      });
    }
  }

  function extractText(blocks: ReadonlyArray<MessageContentBlock>): string {
    for (const block of blocks) {
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text;
      }
    }
    throw new Error('[agent-sdk] response missing text block');
  }

  async function respondTo(question: Question): Promise<Position> {
    assertSignalOpen();
    const response = await opts.anthropic.messages.create({
      model,
      system: systemPrompt,
      max_tokens: maxTokens,
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      messages: [
        {
          role: 'user',
          content: buildPositionPrompt(question),
        },
      ],
    });
    await drainThinking(response.content, question.id);
    const parsed = parseJsonObject(extractText(response.content));
    return {
      id: `pos-${question.id}-${principalId}`,
      type: 'position',
      inResponseTo: question.id,
      answer: requireString(parsed, 'answer'),
      rationale: requireString(parsed, 'rationale'),
      derivedFrom: sanitizeStringArray(parsed['derivedFrom']),
      authorPrincipal: principalId,
      created_at: new Date().toISOString(),
    };
  }

  async function counterOnce(
    positions: ReadonlyArray<Position>,
  ): Promise<Counter | null> {
    assertSignalOpen();
    const othersPositions = positions.filter(
      (p) => p.authorPrincipal !== principalId,
    );
    if (othersPositions.length === 0) return null;

    const response = await opts.anthropic.messages.create({
      model,
      system: systemPrompt,
      max_tokens: counterMaxTokens,
      thinking: {
        type: 'enabled',
        budget_tokens: counterBudget,
      },
      messages: [
        {
          role: 'user',
          content: buildCounterPrompt(othersPositions),
        },
      ],
    });
    await drainThinking(response.content, othersPositions[0]!.inResponseTo);

    const parsed = parseJsonObject(extractText(response.content));
    if (
      parsed['counter'] === null
      || typeof parsed['targetPositionId'] !== 'string'
      || (parsed['targetPositionId'] as string).length === 0
    ) {
      return null;
    }
    const targetId = parsed['targetPositionId'] as string;
    return {
      id: `ctr-${targetId}-${principalId}`,
      type: 'counter',
      inResponseTo: targetId,
      objection: requireString(parsed, 'objection'),
      derivedFrom: sanitizeStringArray(parsed['derivedFrom']),
      authorPrincipal: principalId,
      created_at: new Date().toISOString(),
    };
  }

  return {
    id: principalId,
    pause() {
      state = 'paused';
    },
    resume() {
      state = 'running';
    },
    stop() {
      state = 'stopped';
    },
    status() {
      return state;
    },
    respondTo,
    counterOnce,
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildPositionPrompt(q: Question): string {
  return [
    `Question (id=${q.id}): ${q.prompt}`,
    '',
    'Post your Position. Reply with a single JSON object (no prose, no code',
    'fence required):',
    '',
    '  {',
    '    "answer": string,        // the concrete stance you take',
    '    "rationale": string,     // why this answer, grounded in canon or',
    '                             // your principal goals/constraints',
    '    "derivedFrom": string[]  // atom ids you cited (may be empty)',
    '  }',
  ].join('\n');
}

function buildCounterPrompt(others: ReadonlyArray<Position>): string {
  const lines: string[] = [];
  lines.push('Other principals have posted these positions:');
  lines.push('');
  for (const p of others) {
    lines.push(`- id=${p.id}, author=${p.authorPrincipal}`);
    lines.push(`  answer: ${p.answer}`);
    lines.push(`  rationale: ${p.rationale}`);
  }
  lines.push('');
  lines.push(
    'Do you have a counter to any of them? Reply with a single JSON object:',
  );
  lines.push('');
  lines.push('  { "counter": null }');
  lines.push('');
  lines.push('when you have no objection, OR:');
  lines.push('');
  lines.push('  {');
  lines.push('    "targetPositionId": string, // id of the position you object to');
  lines.push('    "objection": string,        // the specific objection');
  lines.push('    "derivedFrom": string[]     // supporting atom ids');
  lines.push('  }');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Parse the first `{...}` JSON object from an agent response, tolerating
 * common wrappers like markdown code fences. Throws on missing/invalid
 * JSON so the coordinator surfaces the failing round to the operator.
 */
function parseJsonObject(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('[agent-sdk] response has no JSON object');
  }
  const parsed: unknown = JSON.parse(match[0]);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('[agent-sdk] parsed JSON is not an object');
  }
  return parsed as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[agent-sdk] response JSON missing required string field "${key}"`);
  }
  return value;
}

function sanitizeStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
