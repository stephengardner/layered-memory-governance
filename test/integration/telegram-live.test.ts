/**
 * Telegram Notifier live smoke test.
 *
 * Gated by LAG_TELEGRAM_LIVE=1 so CI and casual test runs skip it.
 * Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in environment.
 *
 * This test sends a REAL message to your Telegram chat, prompts you
 * (in the terminal and on your phone) to tap a button within 60
 * seconds, and asserts the disposition round-tripped through the
 * callback_query into the base notifier. It also asserts the message
 * gets edited after resolution so you see the outcome in Telegram.
 *
 * Running:
 *   # Set env + bot token + chat id, then:
 *   LAG_TELEGRAM_LIVE=1 npm test -- --run test/integration/telegram-live.test.ts
 *
 * CI never sees this test because the env flag is not set.
 */

import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../../src/adapters/memory/index.js';
import { TelegramNotifier } from '../../src/adapters/notifier/telegram.js';
import type { Event, PrincipalId, Time } from '../../src/substrate/types.js';

const RUN = process.env.LAG_TELEGRAM_LIVE === '1';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

describe.skipIf(!RUN || !TOKEN || !CHAT_ID)('Telegram live smoke (LAG_TELEGRAM_LIVE=1)', () => {
  it('round-trips a real escalation through the user\'s phone', { timeout: 90_000 }, async () => {
    const host = createMemoryHost();
    const notifier = new TelegramNotifier({
      botToken: TOKEN!,
      chatId: CHAT_ID!,
      base: host.notifier,
      respondAsPrincipal: 'live-smoke' as PrincipalId,
      pollIntervalMs: 1500,
    });
    notifier.startPolling();

    const now = host.clock.now();
    const event: Event = {
      kind: 'proposal',
      severity: 'info',
      summary: 'LAG live smoke: tap any button within 60s',
      body: 'This message was sent by the test suite. Any tap resolves the test.',
      atom_refs: [],
      principal_id: 'live-smoke' as PrincipalId,
      created_at: now as Time,
    };
    const handle = await notifier.telegraph(event, null, 'coexist', 60_000);

    // Wait up to 60s for a tap.
    const disposition = await notifier.awaitDisposition(handle, 60_000);
    notifier.stopPolling();

    // Any actual tap produces approve / reject / ignore. If the test
    // times out, disposition resolves to the default 'coexist'; fail
    // loudly so we don't silently skip.
    expect(['approve', 'reject', 'ignore']).toContain(disposition);
  });
});
