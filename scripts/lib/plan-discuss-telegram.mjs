import { randomBytes } from 'node:crypto';

/**
 * Pure helpers for scripts/plan-discuss-telegram.mjs.
 *
 * V1 single-turn discuss flow:
 *   1. Send plan body via Telegram with [Approve][Reject][Discuss] keyboard.
 *   2. Poll getUpdates for callback_query (button) and message (text-reply) events.
 *   3. On Discuss tap: prompt for question, wait for next text reply.
 *   4. Generate CTO response via Anthropic SDK (focused single-turn).
 *   5. Send response back, re-prompt with same keyboard.
 *   6. Loop until Approve / Reject / timeout.
 *
 * Lives in scripts/lib/ (no shebang) so vitest+esbuild on Windows-CI
 * can import it from .test.ts. Same pattern as the approve helpers.
 */

export const DEFAULT_TIMEOUT_MS = 600_000;
export const DISCUSSION_BODY_MAX = 800;
export const DISCUSSION_QUESTION_MAX = 1500;
export const CTO_RESPONSE_MAX_TOKENS = 500;

/**
 * Parse argv shape: `<plan-id> [--timeout ms] [--principal id] [--no-llm]`.
 * --no-llm skips the Anthropic API call (test/diagnostic mode); the script
 * sends a placeholder response instead so the operator can still validate
 * the round-trip plumbing without burning tokens.
 */
export function parseArgs(argv) {
  const args = {
    planId: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    principal: null,
    noLlm: false,
    help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '--timeout') {
      if (i + 1 >= argv.length) throw new Error('missing value for --timeout');
      const next = argv[++i];
      const num = Number(next);
      if (!Number.isFinite(num)) throw new Error(`invalid value for --timeout: ${next}`);
      args.timeoutMs = num;
    } else if (a === '--principal') {
      if (i + 1 >= argv.length) throw new Error('missing value for --principal');
      args.principal = String(argv[++i]).trim() || null;
    } else if (a === '--no-llm') {
      args.noLlm = true;
    } else if (typeof a === 'string' && a.startsWith('--')) {
      throw new Error(`unknown option: ${a}`);
    } else {
      rest.push(a);
    }
  }
  args.planId = rest.join(' ').trim();
  return args;
}

/**
 * Validate the parsed args. Returns {ok: boolean, error?: string} so the
 * caller distinguishes a usage hint (exit 2) from a fatal exit (exit 1).
 */
export function validateArgs(args) {
  if (!args.planId) {
    return { ok: false, error: 'missing plan-id (positional)' };
  }
  if (
    !Number.isFinite(args.timeoutMs)
    || !Number.isInteger(args.timeoutMs)
    || args.timeoutMs <= 0
  ) {
    return { ok: false, error: '--timeout must be a positive integer (ms)' };
  }
  return { ok: true };
}

/**
 * Telegram callback_data is bounded to 64 BYTES (not chars) by the
 * Bot API. Our format `discuss:<tag>:<action>` uses ~17 chars of
 * fixed framing, leaving ~47 for the tag. Plan ids in this repo are
 * usually well under that, but auto-generated ids (e.g. plan-author
 * stubs with timestamps) can run long. To stay below the limit
 * unconditionally, fold any tag longer than the safe budget down
 * into a stable hex hash. The same hash routine runs on the parse
 * side so callbacks round-trip.
 */
const CALLBACK_TAG_MAX = 40; // ample headroom under 64 - len('discuss::reject')

function hashTag(tag) {
  // Simple deterministic hash, no crypto dep needed: sum-of-codepoints
  // mixed with FNV-1a-style spread, hex-truncated to 16 chars (64 bits).
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < tag.length; i++) {
    h1 = Math.imul(h1 ^ tag.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ tag.charCodeAt(i), 0x85ebca77) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

export function encodeTag(tag) {
  if (typeof tag !== 'string') throw new Error('encodeTag: tag must be a string');
  return tag.length > CALLBACK_TAG_MAX ? `h.${hashTag(tag)}` : tag;
}

/**
 * Build the inline-keyboard for the plan-discuss flow. Three buttons:
 *   [Approve] [Reject]
 *   [Discuss]
 * encoded with a tag prefix so the script can disambiguate from any
 * stale callbacks issued by other Telegram bots/flows on the same chat.
 *
 * Long tags are folded into a stable hash via encodeTag so callback_data
 * always fits Telegram's 64-byte limit. The script must call
 * encodeTag(planId) once and pass the SAME encoded value to both
 * buildKeyboard and parseCallback so the round-trip matches.
 */
export function buildKeyboard(tag) {
  const t = encodeTag(tag);
  return {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `discuss:${t}:approve` },
        { text: 'Reject', callback_data: `discuss:${t}:reject` },
      ],
      [
        { text: 'Discuss', callback_data: `discuss:${t}:discuss` },
      ],
    ],
  };
}

/**
 * Parse a callback_data string emitted by buildKeyboard. Returns the
 * action ('approve' | 'reject' | 'discuss') if the tag matches and the
 * shape is valid; null otherwise. Defensive against non-LAG callbacks
 * landing in the same getUpdates batch.
 */
export function parseCallback(data, expectedTag) {
  if (typeof data !== 'string') return null;
  const parts = data.split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'discuss') return null;
  if (parts[1] !== expectedTag) return null;
  const action = parts[2];
  if (action !== 'approve' && action !== 'reject' && action !== 'discuss') return null;
  return action;
}

/**
 * Format a Telegram body for the initial plan-presentation message.
 * Truncates the plan body to keep the wire payload bounded; Telegram's
 * own message-size limit is 4096 chars but a phone screen is ~600.
 */
export function formatInitialMessage(planId, summary) {
  const title = summary?.title ?? '(no title)';
  const body = summary?.body ?? '';
  const trimmed = body.length > DISCUSSION_BODY_MAX
    ? `${body.slice(0, DISCUSSION_BODY_MAX)}...(truncated)`
    : body;
  return [
    `LAG: plan awaiting your verdict`,
    ``,
    `Plan: ${title}`,
    ``,
    trimmed,
    ``,
    `ID: ${planId}`,
    ``,
    `Tap a button below, or tap Discuss to ask the CTO a question first.`,
  ].join('\n');
}

/**
 * Format a Telegram body for the CTO discussion-reply turn.
 * Carries the original question (so the operator sees what they asked
 * scrolled-up on a phone) plus the CTO response.
 */
export function formatDiscussReply(question, response) {
  const trimmedQ = String(question ?? '').slice(0, DISCUSSION_QUESTION_MAX);
  const trimmedR = String(response ?? '').slice(0, DISCUSSION_BODY_MAX);
  return [
    `Q: ${trimmedQ}`,
    ``,
    `CTO:`,
    trimmedR,
    ``,
    `Tap Approve / Reject, or Discuss again.`,
  ].join('\n');
}

/**
 * Build the system-prompt for the CTO discussion-response LLM call.
 * Keeps the prompt scoped: the CTO speaks only about the plan in hand,
 * doesn't pull in unrelated canon, and is asked for a phone-readable
 * answer (under 300 chars when possible).
 *
 * V1 deliberately does NOT thread prior atoms in. A future "self-context"
 * pass (per the org-ceiling roadmap) will extend this prompt with the
 * principal's recent plan + decision history. Today the response is a
 * fresh single-turn judgment.
 */
export function formatCtoPrompt(plan, question) {
  const title = plan?.id ?? '(unknown)';
  const planBody = String(plan?.content ?? '').slice(0, 2000);
  /*
   * Cap the operator question at DISCUSSION_QUESTION_MAX before
   * injecting into the LLM prompt. formatDiscussReply and
   * buildDiscussionAtom already cap on their respective surfaces;
   * without this cap, an unbounded question can blow the LLM's
   * context budget on a single user message.
   */
  const trimmedQ = String(question ?? '').slice(0, DISCUSSION_QUESTION_MAX);
  return [
    `You are LAG's cto-actor responding to the operator about a proposed plan.`,
    `The operator is on their phone; respond in 100-300 characters when possible.`,
    `Be specific to THIS plan; do not invent context not in the plan body.`,
    ``,
    `Plan id: ${title}`,
    `Plan body:`,
    planBody,
    ``,
    `Operator question:`,
    trimmedQ,
    ``,
    `Respond directly to the operator. No greeting, no signature.`,
  ].join('\n');
}

/**
 * Assemble a plan-discussion atom from the Q+A pair. The atom is
 * type='plan-discussion' (a new conversational-trace type) and lives at
 * layer L0 (it's an observation, not canon). Provenance chain points
 * back at the plan id so the audit trail joins cleanly. Records both
 * the question and the response so the operator and any future actor
 * can replay the conversation.
 */
export function buildDiscussionAtom({
  planId,
  question,
  response,
  principalId,
  createdAt,
  noLlm = false,
}) {
  if (!planId || typeof planId !== 'string') {
    throw new Error('buildDiscussionAtom: planId required');
  }
  if (!principalId || typeof principalId !== 'string') {
    throw new Error('buildDiscussionAtom: principalId required');
  }
  if (!createdAt || typeof createdAt !== 'string') {
    throw new Error('buildDiscussionAtom: createdAt required (ISO timestamp)');
  }
  /*
   * Validate the timestamp parses cleanly. Date.parse returns NaN for
   * invalid input; without this guard, an unparseable createdAt produces
   * an atom id like 'plan-discussion-<plan>-NaN', breaking the audit chain.
   */
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) {
    throw new Error(`buildDiscussionAtom: createdAt must be a valid ISO timestamp, got ${JSON.stringify(createdAt)}`);
  }
  /*
   * 6-hex-char nonce so two Q/A events landing in the same millisecond
   * don't collide on id. Same shape as mkKillSwitchTrippedAtomId in
   * src/runtime/kill-switch. crypto.randomBytes is the right RNG; a
   * Math.random nonce would be predictable and a sub-principal could
   * front-run a later event by guessing the next id.
   */
  const nonce = randomBytes(3).toString('hex');
  const id = `plan-discussion-${planId}-${ts}-${nonce}`;
  return {
    schema_version: 1,
    id,
    /*
     * type='observation' is the canonical AtomType for "this happened"
     * conversational records (per src/substrate/types.ts AtomType
     * union). The discussion-specific shape is carried in
     * metadata.kind='plan-discussion'; the audit projection layer
     * filters via metadata to surface the conversation thread.
     * Adding a new AtomType for a tactical case would violate canon
     * `dev-canon-strategic-not-tactical`.
     */
    type: 'observation',
    layer: 'L0',
    content: `Operator question: ${String(question ?? '').slice(0, DISCUSSION_QUESTION_MAX)}\n\nCTO response: ${String(response ?? '').slice(0, DISCUSSION_BODY_MAX)}`,
    principal_id: principalId,
    confidence: 0.9,
    created_at: createdAt,
    last_reinforced_at: createdAt,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    provenance: {
      /*
       * 'agent-inferred': the response side of the Q/A is the CTO
       * (LLM agent) inferring an answer from plan context. The
       * question side is operator-asserted but the atom records
       * BOTH and the response is the load-bearing content. Valid
       * member of ProvenanceKind in src/substrate/types.ts.
       */
      kind: 'agent-inferred',
      source: { session_id: 'plan-discuss-telegram', agent_id: 'cto-actor' },
      derived_from: [planId],
    },
    taint: 'clean',
    metadata: {
      kind: 'plan-discussion',
      plan_id: planId,
      via: 'telegram',
      llm_used: !noLlm,
    },
  };
}
