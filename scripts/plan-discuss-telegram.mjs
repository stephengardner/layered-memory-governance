#!/usr/bin/env node
/**
 * Plan-discuss-telegram: operator-conversation surface for a single plan,
 * accessible from a phone via Telegram.
 *
 * The gap this closes: plan-approve-telegram.mjs only carries
 * Approve / Reject. Often the operator wants to ASK the CTO a
 * question first ("why this approach?", "what's the blast radius?",
 * "did you consider X?") and only THEN decide. This script adds a
 * Discuss button that triggers a single-turn Q -> A exchange with the
 * CTO before falling back to the Approve / Reject menu.
 *
 * V1 scope:
 *   - Single-turn discuss: one operator question, one CTO response.
 *   - Multi-turn (multiple back-and-forths) is a follow-up.
 *   - CTO response is generated via Anthropic SDK with a focused
 *     single-turn prompt; the full PlanningActor pipeline is NOT
 *     invoked here (too heavy for a phone-side conversation surface).
 *   - Each Q/A pair is recorded as a `plan-discussion` atom for audit.
 *
 * Usage:
 *   node scripts/plan-discuss-telegram.mjs <plan-id>
 *   node scripts/plan-discuss-telegram.mjs <plan-id> --timeout 600000
 *   node scripts/plan-discuss-telegram.mjs <plan-id> --no-llm   (test mode)
 *
 * Env (loaded from .env):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  -- mandatory
 *   LAG_TG_PRINCIPAL                      -- override responder principal
 *   LAG_OPERATOR_ID                       -- last-resort principal default
 *   LAG_TG_DISCUSS_CMD                    -- override CLI binary (default: claude)
 *
 * The CTO response uses the Claude Code CLI (`claude -p`) by default --
 * operators already have it installed for the indie-floor flow, so no
 * separate Anthropic API key is required. The CLI inherits OAuth from
 * the user's existing claude-code install. The org-ceiling override
 * is a future flag (deferred); --no-llm bypasses the CTO call entirely
 * for diagnostic / round-trip-only runs.
 *
 * Exit codes:
 *   0  approved | rejected applied
 *   2  timeout | ignored | STOP sentinel | bad/non-proposed plan | missing principal
 *   3  CLI binary not found on PATH (without --no-llm)
 *   1  unexpected error (network / token / transition error)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileHost } from '../dist/adapters/file/index.js';
import { transitionPlanState } from '../dist/runtime/plans/state.js';
import {
  parseArgs,
  validateArgs,
  buildKeyboard,
  parseCallback,
  encodeTag,
  formatInitialMessage,
  formatDiscussReply,
  formatCtoPrompt,
  buildDiscussionAtom,
} from './lib/plan-discuss-telegram.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const TELEGRAM_BASE = 'https://api.telegram.org';

function resolveResponderPrincipal(cli) {
  return cli || process.env.LAG_TG_PRINCIPAL || process.env.LAG_OPERATOR_ID || null;
}

async function loadDotEnv() {
  try {
    const text = await readFile(resolve(REPO_ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No .env, fall back to process.env.
  }
}

function printHelp() {
  console.log([
    'Usage: node scripts/plan-discuss-telegram.mjs <plan-id> [--timeout ms] [--principal id] [--no-llm]',
    '',
    'Env (required):',
    '  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID',
    'Env (optional):',
    '  LAG_TG_DISCUSS_CMD  (default: claude; the CLI binary used for the CTO call)',
    '',
    'Principal resolution (highest first):',
    '  --principal <id>',
    '  LAG_TG_PRINCIPAL',
    '  LAG_OPERATOR_ID',
    '  (no fallback; the script exits 2 if none resolves)',
    '',
    'Exit codes:',
    '  0  approved | rejected applied',
    '  2  timeout | ignored | STOP | bad plan | missing principal',
    '  3  CLI binary not found on PATH (without --no-llm)',
    '  1  unexpected error',
  ].join('\n'));
}

async function tg(method, params) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `${TELEGRAM_BASE}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Telegram ${method} ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  if (!j.ok) throw new Error(`Telegram ${method} not ok: ${JSON.stringify(j).slice(0, 200)}`);
  return j.result;
}

async function sendText(chatId, text, replyMarkup) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(callbackQueryId, text) {
  return tg('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  }).catch(() => undefined);
}

/**
 * Long-poll getUpdates until either:
 *   - a callback_query whose data matches our tag arrives -> return
 *     { kind: 'callback', action, queryId }
 *   - a message with text from our chat arrives -> return
 *     { kind: 'message', text }
 *   - the deadline passes -> return { kind: 'timeout' }
 *
 * Maintains an internal offset in the closure passed by the driver so
 * stale updates don't replay across calls.
 */
async function pollUpdates({ chatId, tag, deadlineMs, getOffset, setOffset }) {
  while (Date.now() < deadlineMs) {
    const remaining = Math.max(1, Math.floor((deadlineMs - Date.now()) / 1000));
    const longPoll = Math.min(25, remaining);
    let updates;
    try {
      updates = await tg('getUpdates', {
        offset: getOffset(),
        timeout: longPoll,
        limit: 50,
      });
    } catch (err) {
      // Network blips: log + brief backoff + retry.
      console.error(`[discuss] getUpdates error: ${(err && err.message) || err}`);
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    for (const u of updates) {
      if (typeof u.update_id === 'number' && u.update_id >= getOffset()) {
        setOffset(u.update_id + 1);
      }
      if (u.callback_query && typeof u.callback_query.data === 'string') {
        /*
         * Defense-in-depth: the inline-keyboard tag already namespaces
         * our callbacks ('discuss:<tag>:<action>'), but if the bot is
         * a member of multiple chats and another chat sends a callback
         * that happens to match our tag pattern, the chat-id check
         * below makes sure we only act on callbacks from THIS chat.
         */
        if (u.callback_query.message && u.callback_query.message.chat && u.callback_query.message.chat.id !== chatId) {
          continue;
        }
        const action = parseCallback(u.callback_query.data, tag);
        if (action) {
          return { kind: 'callback', action, queryId: u.callback_query.id };
        }
      }
      if (u.message && u.message.chat && u.message.chat.id === chatId && typeof u.message.text === 'string') {
        const txt = u.message.text.trim();
        if (txt.length > 0 && !txt.startsWith('/')) {
          return { kind: 'message', text: txt };
        }
      }
    }
  }
  return { kind: 'timeout' };
}

/**
 * Single-turn CTO response via Anthropic SDK. Bounded to
 * CTO_RESPONSE_MAX_TOKENS so the phone-display stays compact and the
 * spend stays predictable.
 */
/*
 * 90s read-timeout for the Claude CLI call. The CLI inherits OAuth
 * from the operator's local claude-code install, so no API key is
 * needed -- this is the indie-floor path. CLI startup + a 500-token
 * response typically completes in 5-30s; 90s is generous headroom
 * for slow networks. AbortSignal.timeout (Node >=18) terminates the
 * spawn cleanly so a hung CLI doesn't stall the Telegram loop.
 */
const CLI_TIMEOUT_MS = 90_000;

/**
 * Single-turn CTO response via the Claude Code CLI. Spawns
 * `claude -p "<prompt>"` with stdin-prompt mode (--print) and
 * captures stdout. The CLI inherits the operator's OAuth, so no
 * separate ANTHROPIC_API_KEY is required (indie-floor design).
 *
 * Org-ceiling deployments that want a different LLM path (Anthropic
 * SDK with explicit key, Bedrock, Vertex, etc.) override the binary
 * via LAG_TG_DISCUSS_CMD. The script-level CLI spawn keeps the
 * indie default zero-config; the binary swap is the future-proof
 * seam without forcing API-key plumbing into the indie path.
 */
async function ctoRespond(plan, question) {
  const cmd = process.env.LAG_TG_DISCUSS_CMD || 'claude';
  const prompt = formatCtoPrompt(plan, question);
  return await new Promise((resolveResult, reject) => {
    const child = spawn(cmd, ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`Claude CLI timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err && err.code === 'ENOENT') {
        reject(new Error(
          `Claude CLI binary '${cmd}' not found on PATH. ` +
          'Install Claude Code (https://claude.ai/code) or set LAG_TG_DISCUSS_CMD.',
        ));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (ac.signal.aborted) return; // already rejected via timeout
      if (code !== 0) {
        reject(new Error(
          `Claude CLI exited ${code}. stderr: ${stderr.slice(0, 300)}`,
        ));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error('Claude CLI returned empty stdout'));
        return;
      }
      resolveResult(text);
    });
  });
}

/**
 * Dispatch a verdict callback (approve / reject) to the host: write
 * the state transition + ack the operator over Telegram. Returns the
 * exit code so the caller can break the loop. Used by both the
 * top-level loop iteration and the discuss-wait branch (where the
 * operator may tap Approve/Reject instead of typing a question --
 * without this shared dispatcher, the inner-poll callback would be
 * lost because its update_id has already been advanced past).
 */
async function applyVerdict({
  action, queryId, host, principal, chatId, args,
}) {
  if (action === 'approve') {
    await answerCallback(queryId, 'LAG: approved');
    await transitionPlanState(args.planId, 'approved', host, principal, 'operator-approved-via-telegram-discuss');
    await sendText(chatId, `Approved. Plan ${args.planId} -> 'approved'.`);
    console.log(`[discuss] approved. Plan ${args.planId} -> 'approved'.`);
    return 0;
  }
  if (action === 'reject') {
    await answerCallback(queryId, 'LAG: rejected');
    await transitionPlanState(args.planId, 'abandoned', host, principal, 'operator-rejected-via-telegram-discuss');
    await sendText(chatId, `Rejected. Plan ${args.planId} -> 'abandoned'.`);
    console.log(`[discuss] rejected. Plan ${args.planId} -> 'abandoned'.`);
    return 0;
  }
  return null; // not a verdict; caller falls through to discuss/loop
}

/**
 * Shared discuss-question handler invoked from both the
 * callback-tap-discuss branch and the implicit-message branch. Returns
 * { ok: true } on success or { ok: false } on CTO-call failure so the
 * caller can `continue` the loop without aborting the whole session.
 */
async function handleDiscussQuestion({
  question, plan, host, principal, chatId, keyboard, args,
}) {
  let response;
  if (args.noLlm) {
    response = '(--no-llm: skipping CTO call. Question recorded as audit.)';
  } else {
    try {
      response = await ctoRespond(plan, question);
    } catch (err) {
      console.error(`[discuss] CTO call failed: ${(err && err.message) || err}`);
      await sendText(chatId, `CTO call failed: ${String(err && err.message || err).slice(0, 300)}`);
      return { ok: false };
    }
  }
  const atom = buildDiscussionAtom({
    planId: args.planId,
    question,
    response,
    principalId: principal,
    createdAt: host.clock.now(),
    noLlm: args.noLlm,
  });
  try {
    await host.atoms.put(atom);
  } catch (err) {
    /*
     * Audit miss is non-fatal for the conversation; the operator
     * still gets the response. The atom write failure is logged so
     * the operator can see it post-hoc.
     */
    console.error(`[discuss] failed to write plan-discussion atom: ${(err && err.message) || err}`);
  }
  await sendText(chatId, formatDiscussReply(question, response), keyboard);
  return { ok: true };
}

async function main() {
  await loadDotEnv();
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err?.message ?? err}`);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const validation = validateArgs(args);
  if (!validation.ok) {
    console.error(`ERROR: ${validation.error}`);
    printHelp();
    /*
     * exit 2 (not 1) because this branch is user-input failure --
     * matches the parseArgs-throws branch above and the rest of the
     * script's exit-code documentation. exit 1 is reserved for
     * unexpected runtime errors (network, transition conflicts, etc).
     */
    process.exit(2);
  }

  const principal = resolveResponderPrincipal(args.principal);
  if (!principal) {
    console.error('ERROR: no principal resolved. Set --principal, LAG_TG_PRINCIPAL, or LAG_OPERATOR_ID.');
    process.exit(2);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIdRaw = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatIdRaw) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set.');
    /*
     * exit 2: configuration error (recoverable with env edit), not 1
     * (unexpected runtime failure). Same convention as the missing-
     * principal branch above.
     */
    process.exit(2);
  }
  const chatId = Number(chatIdRaw);
  if (!Number.isFinite(chatId)) {
    console.error(`TELEGRAM_CHAT_ID must be numeric, got: ${chatIdRaw}`);
    process.exit(2);
  }

  /*
   * No ANTHROPIC_API_KEY check here -- the CLI path is the default
   * indie-floor flow and inherits OAuth from the operator's local
   * claude-code install. The first LLM call will surface ENOENT if
   * the binary is missing; ctoRespond translates that to a clear
   * exit-3 error message.
   */

  const rootDir = resolve(REPO_ROOT, '.lag');
  const stopSentinel = resolve(rootDir, 'STOP');
  if (existsSync(stopSentinel)) {
    console.error(`STOP sentinel present at ${stopSentinel}; halting.`);
    process.exit(2);
  }

  const host = await createFileHost({ rootDir });
  const plan = await host.atoms.get(args.planId);
  if (!plan) {
    console.error(`Plan not found: ${args.planId}`);
    process.exit(2);
  }
  if (plan.type !== 'plan') {
    console.error(`Atom ${args.planId} is type=${plan.type}, not a plan.`);
    process.exit(2);
  }
  if (plan.plan_state !== 'proposed') {
    console.error(`Plan ${args.planId} is in state '${plan.plan_state}'; only proposed plans can be discussed here.`);
    process.exit(2);
  }

  /*
   * Build the initial message from the plan body. We use the plan's
   * first markdown heading as the title (if any) and the rest as the
   * body, mirroring the formatPlanSummary contract from the
   * approve-telegram script.
   */
  const summary = (() => {
    const content = String(plan.content ?? '');
    const lines = content.split('\n');
    let title = '';
    let bodyStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#{1,3}\s+(.+)$/);
      if (m) {
        title = m[1].trim();
        bodyStart = i + 1;
        break;
      }
    }
    return { title: title || `(no title - id ${plan.id})`, body: lines.slice(bodyStart).join('\n').trim() };
  })();

  /*
   * encodeTag folds plan-ids longer than ~40 chars into a stable
   * hash so the assembled callback_data fits Telegram's 64-byte
   * limit. parseCallback uses the same encoded tag, so callbacks
   * round-trip correctly even for hashed ids.
   */
  /*
   * Compute the encoded tag once, then pass it to BOTH buildKeyboard
   * (the caller-side encoder) and parseCallback (the receiver-side
   * decoder) so callbacks round-trip even for plan-ids longer than
   * the 40-char direct-encoding budget. Passing the raw plan-id to
   * buildKeyboard would re-encode it inside the helper but yield a
   * different encoded value than what pollUpdates compares against.
   */
  const tag = encodeTag(args.planId);
  const keyboard = buildKeyboard(tag);

  /*
   * Establish a fresh offset baseline so we don't pick up any stale
   * updates from prior bot runs. A getUpdates call with offset=-1
   * returns the most recent update; we use its update_id+1 as our
   * starting offset.
   */
  let offset = 0;
  try {
    const seed = await tg('getUpdates', { offset: -1, timeout: 0, limit: 1 });
    if (seed.length > 0 && typeof seed[0].update_id === 'number') {
      offset = seed[0].update_id + 1;
    }
  } catch (err) {
    console.error(`[discuss] could not seed update offset: ${(err && err.message) || err}`);
  }
  const getOffset = () => offset;
  const setOffset = (v) => { offset = v; };

  await sendText(chatId, formatInitialMessage(args.planId, summary), keyboard);
  console.log(`[discuss] message sent. Awaiting operator action (timeout ${args.timeoutMs}ms).`);

  let exitCode = 1;
  const deadlineMs = Date.now() + args.timeoutMs;

  while (Date.now() < deadlineMs) {
    const evt = await pollUpdates({ chatId, tag, deadlineMs, getOffset, setOffset });
    if (evt.kind === 'timeout') {
      console.error('[discuss] timed out without a verdict. Plan stays in proposed.');
      exitCode = 2;
      break;
    }
    if (evt.kind === 'callback' && (evt.action === 'approve' || evt.action === 'reject')) {
      const code = await applyVerdict({
        action: evt.action, queryId: evt.queryId, host, principal, chatId, args,
      });
      if (code !== null) {
        exitCode = code;
        break;
      }
    }
    if (evt.kind === 'callback' && evt.action === 'discuss') {
      await answerCallback(evt.queryId, 'LAG: send your question as a reply');
      await sendText(
        chatId,
        'Send your question as a reply to this message. The CTO will respond, then you can Approve / Reject / Discuss again.',
      );
      // Wait for either a text reply OR another button tap.
      const next = await pollUpdates({ chatId, tag, deadlineMs, getOffset, setOffset });
      if (next.kind === 'timeout') {
        console.error('[discuss] timed out waiting for question text. Plan stays in proposed.');
        exitCode = 2;
        break;
      }
      /*
       * If the operator taps a button instead of typing, dispatch the
       * verdict immediately. Falling through with `continue` would
       * lose the callback because its update_id has been advanced
       * past in pollUpdates -- the next outer-loop pollUpdates will
       * never see it.
       */
      if (next.kind === 'callback') {
        if (next.action === 'discuss') {
          // Operator tapped Discuss again; loop back and reprompt.
          continue;
        }
        const code = await applyVerdict({
          action: next.action, queryId: next.queryId, host, principal, chatId, args,
        });
        if (code !== null) {
          exitCode = code;
          break;
        }
      }
      if (next.kind === 'message') {
        await handleDiscussQuestion({
          question: next.text, plan, host, principal, chatId, keyboard, args,
        });
      }
      continue;
    }
    if (evt.kind === 'message') {
      // Operator sent a free message without first tapping Discuss.
      // Treat as an implicit discuss request: same flow.
      await handleDiscussQuestion({
        question: evt.text, plan, host, principal, chatId, keyboard, args,
      });
      continue;
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('plan-discuss-telegram fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
