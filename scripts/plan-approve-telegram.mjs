#!/usr/bin/env node
/**
 * Plan-approve-telegram: operator-approval surface for a single plan,
 * accessible from a phone via Telegram inline-keyboard buttons.
 *
 * The gap this closes: a CTO-drafted plan that fails auto-approve
 * (its sub-actor is not in pol-plan-auto-approve-low-stakes' allowlist)
 * sits in 'proposed' state forever waiting for the operator at a
 * terminal. With this script the operator opens it on their phone,
 * taps Approve or Reject, and the plan transitions immediately
 * through the existing transitionPlanState primitive.
 *
 * Scope (V0):
 *   - Single-plan invocation: `node scripts/plan-approve-telegram.mjs <plan-id>`
 *   - Two outcomes: Approve / Reject. No freeform discuss yet
 *     (deferred follow-up per README).
 *   - Operator-runnable; no autoloop. Operator runs it explicitly
 *     when they want a plan on their phone.
 *
 * Usage:
 *   node scripts/plan-approve-telegram.mjs <plan-id>
 *   node scripts/plan-approve-telegram.mjs <plan-id> --timeout 300000
 *
 * Env vars (loaded from .env):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID - mandatory; same as
 *   telegram-ask.mjs. The TelegramNotifier maps inline-keyboard taps
 *   to base-notifier dispositions.
 *
 * Exit codes:
 *   0   Operator made a verdict (approve or reject); applied + audited.
 *   2   Timed out / kill-switch / bad plan id / non-proposed state.
 *   1   Any other failure (bad token, bad chat id, network, transition error).
 *
 * Composition:
 *   FileHost (.lag/)             - state of truth for the plan atom
 *     |
 *     +- TelegramNotifier        - inline-keyboard message + callback poll
 *     |    [Approve][Reject][Ignore]   (Ignore -> timeout / re-run)
 *     |
 *     +- transitionPlanState     - approved | abandoned (state-machine guarded)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileHost } from '../dist/adapters/file/index.js';
import { TelegramNotifier } from '../dist/adapters/notifier/telegram.js';
import { transitionPlanState } from '../dist/runtime/plans/state.js';
import { parseArgs, validateArgs, formatPlanSummary } from './lib/plan-approve-telegram.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/*
 * Principal that records the plan transition in the audit log.
 * Resolved from --principal flag, then LAG_TG_PRINCIPAL env, then
 * LAG_OPERATOR_ID env. No silent fallback to a hardcoded id, because
 * a wrong principal in an audit row makes the chain lie about who
 * authored a state transition; better to fail loud than mis-attribute.
 * Same discipline as scripts/decide.mjs (LAG_OPERATOR_ID required).
 */
function resolveResponderPrincipal(cliPrincipal) {
  return (
    cliPrincipal
    || process.env.LAG_TG_PRINCIPAL
    || process.env.LAG_OPERATOR_ID
    || null
  );
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
    'Usage: node scripts/plan-approve-telegram.mjs <plan-id> [--timeout ms] [--principal id]',
    '',
    'Env (required):',
    '  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID',
    'Principal resolution (highest first):',
    '  --principal <id>',
    '  LAG_TG_PRINCIPAL',
    '  LAG_OPERATOR_ID',
    '  (no fallback; the script exits 2 if none resolves)',
    '',
    'Exit codes:',
    '  0  approve | reject applied',
    '  2  timeout | ignore | STOP sentinel | bad/non-proposed plan | missing principal',
    '  1  unexpected error (bad token / network / transition error)',
  ].join('\n'));
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
    process.exit(1);
  }

  const principal = resolveResponderPrincipal(args.principal);
  if (!principal) {
    console.error(
      'ERROR: no principal resolved. Set --principal, LAG_TG_PRINCIPAL, or LAG_OPERATOR_ID.',
    );
    console.error('This script writes audit rows and refuses to guess the operator principal.');
    process.exit(2);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set. See .env.example.');
    process.exit(1);
  }

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
    console.error(`Plan ${args.planId} is in state '${plan.plan_state}'; only proposed plans can be approved here.`);
    process.exit(2);
  }

  const notifier = new TelegramNotifier({
    botToken: token,
    chatId,
    base: host.notifier,
    respondAsPrincipal: principal,
    pollIntervalMs: 1500,
  });
  notifier.startPolling();

  let exitCode = 1;
  try {
    const summary = formatPlanSummary(plan);
    const event = {
      kind: 'proposal',
      severity: 'info',
      summary: 'LAG: plan awaiting your verdict',
      body: `Plan: ${summary.title}\n\n${summary.body}\n\nID: ${args.planId}`,
      atom_refs: [args.planId],
      principal_id: principal,
      created_at: host.clock.now(),
    };

    /*
     * The TelegramNotifier hardcodes [Approve][Reject][Ignore] as the
     * inline keyboard. We honor the same vocabulary in the response
     * map: Approve -> approved, Reject -> abandoned, Ignore -> exit-2
     * (operator dismissed without a verdict).
     */
    const handle = await notifier.telegraph(event, null, 'coexist', args.timeoutMs);
    const disposition = await notifier.awaitDisposition(handle, args.timeoutMs);

    if (disposition === 'coexist' || disposition === 'pending') {
      console.error('Timed out without a verdict. Plan stays in proposed.');
      exitCode = 2;
    } else if (disposition === 'approve') {
      await transitionPlanState(
        args.planId,
        'approved',
        host,
        principal,
        'operator-approved-via-telegram',
      );
      console.log(`Approved. Plan ${args.planId} transitioned to 'approved'.`);
      exitCode = 0;
    } else if (disposition === 'reject') {
      await transitionPlanState(
        args.planId,
        'abandoned',
        host,
        principal,
        'operator-rejected-via-telegram',
      );
      console.log(`Rejected. Plan ${args.planId} transitioned to 'abandoned'.`);
      exitCode = 0;
    } else if (disposition === 'ignore') {
      console.log(`Ignored. Plan ${args.planId} stays in proposed.`);
      exitCode = 2;
    } else {
      console.error(`Unexpected disposition '${String(disposition)}'.`);
      exitCode = 1;
    }
  } finally {
    notifier.stopPolling();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('plan-approve-telegram fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
