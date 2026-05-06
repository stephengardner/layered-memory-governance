/**
 * Telegram plan-proposal notifier: deployment-side adapter that the
 * LoopRunner notify pass invokes when a new proposed plan needs to
 * land on the operator's phone.
 *
 * Responsibility:
 *   1. Read TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env.
 *   2. Format a Telegram-friendly message from the plan atom.
 *   3. POST sendMessage to the Telegram bot API.
 *   4. Loud-fail on Telegram API error so the framework counts it as
 *      skipped['notify-failed'] and retries next tick.
 *
 * Returns null from the factory when env is incomplete -> framework
 * silent-skips per the LoopRunner contract. The bin entrypoint
 * (bin/lag-run-loop.js) wires the factory; src/ never reads env.
 *
 * Lives in scripts/lib/ (no shebang) so vitest+esbuild on Windows-CI
 * can import this from a .test.ts without tripping the shebang
 * loader. Same pattern as scripts/lib/pr-observation-refresher.mjs
 * and scripts/lib/plan-summary.mjs.
 *
 * Mirrors scripts/lib/pr-observation-refresher.mjs in shape and
 * budget so future maintainers see one pattern, not two.
 */

import { extractPlanTitleAndBody } from './plan-summary.mjs';

const TELEGRAM_BASE = 'https://api.telegram.org';
/**
 * Telegram's sendMessage body limit is 4096 chars. We cap the
 * message total well below that so the formatting preamble + plan
 * id + run-discuss command have headroom even when the plan body
 * is at its truncation limit.
 */
const MAX_MESSAGE_CHARS = 3500;
const MAX_BODY_CHARS = 3000;
const HTTP_TIMEOUT_MS = 30_000;

/**
 * Validation guard. Throws Error with descriptive message on
 * malformed input. Exported for unit-test pinning so tests can
 * verify the contract without spawning fetch.
 *
 * @param {unknown} args
 * @returns {true}
 */
export function validateNotifyArgs(args) {
  if (!args || typeof args !== 'object') {
    throw new Error('notify: args must be an object');
  }
  const plan = args.plan;
  if (!plan || typeof plan !== 'object') {
    throw new Error('notify: args.plan must be an object {id, content?}');
  }
  if (typeof plan.id !== 'string' || plan.id.length === 0) {
    throw new Error('notify: plan.id must be a non-empty string');
  }
  return true;
}

/**
 * Pure formatter: builds the Telegram message text from a plan
 * atom. Truncates long bodies to keep the message under
 * MAX_MESSAGE_CHARS so a verbose plan does not blow Telegram's
 * 4096-char ceiling.
 *
 * The footer instructs the operator how to launch the discuss
 * script for full Q+A; this is the explicit hand-off from
 * automated push to interactive operator session.
 *
 * Exported for unit tests.
 *
 * @param {{ plan: { id: string, content?: string|null } }} args
 * @returns {string}
 */
export function formatTelegramMessage(args) {
  const { plan } = args;
  const { title, body } = extractPlanTitleAndBody(plan);
  let truncatedBody = body;
  if (truncatedBody.length > MAX_BODY_CHARS) {
    truncatedBody = truncatedBody.slice(0, MAX_BODY_CHARS) + '\n[truncated]';
  }
  const lines = [
    'LAG: new proposed plan',
    '',
    title,
    '',
    truncatedBody,
    '',
    `Plan ID: ${plan.id}`,
    `Discuss / approve on phone: node scripts/plan-discuss-telegram.mjs ${plan.id}`,
  ];
  const msg = lines.join('\n');
  if (msg.length > MAX_MESSAGE_CHARS) {
    return msg.slice(0, MAX_MESSAGE_CHARS - 12) + '\n[truncated]';
  }
  return msg;
}

/**
 * Build the PlanProposalNotifier adapter. Returns null when
 * TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is unset; the framework
 * silent-skips. Both env names match the existing
 * scripts/plan-{approve,discuss}-telegram.mjs conventions so a
 * deployment that already has those scripts working gets the
 * auto-trigger for free.
 *
 * @param {{
 *   readonly fetchImpl?: typeof fetch,
 *   readonly timeoutMs?: number,
 * }} [options]
 */
export function createTelegramPlanProposalNotifier(options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  return {
    /**
     * @param {{ plan: { id: string, content?: string|null } }} args
     */
    async notify(args) {
      validateNotifyArgs(args);
      const text = formatTelegramMessage(args);
      const url = `${TELEGRAM_BASE}/bot${token}/sendMessage`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: String(chatId),
            text,
            disable_web_page_preview: true,
          }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      let json;
      try {
        json = await res.json();
      } catch {
        throw new Error(
          `Telegram sendMessage: response was not JSON (status ${res.status})`,
        );
      }
      if (!json || json.ok !== true) {
        const ec = json && typeof json.error_code !== 'undefined' ? json.error_code : 'unknown';
        const desc = json && typeof json.description !== 'undefined' ? json.description : '';
        throw new Error(`Telegram sendMessage failed: ${ec} ${desc}`);
      }
    },
  };
}
