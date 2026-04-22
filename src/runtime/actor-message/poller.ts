/**
 * InboxPoller: schedules pickNextMessage with a hybrid wake strategy.
 *
 * When the AtomStore advertises `capabilities.hasSubscribe`, the
 * poller uses `subscribe()` for low-latency wake-ups AND runs a
 * correctness poll at a slower cadence (read from pol-inbox-poll-
 * cadence). Polling alone is always correct; subscribe is a latency
 * optimization that degrades cleanly to poll-only when unavailable.
 *
 * The poller is deliberately a thin harness over pickNextMessage;
 * callers that want full control still invoke pickNextMessage
 * directly. The poller exists so daemons and scheduler ticks get a
 * uniform "run this handler when a message arrives" surface without
 * caring whether the backing store supports push.
 */

import type { Host } from '../../interface.js';
import type { PrincipalId } from '../../types.js';
import type { PickupOutcome, PickupOptions } from './pickup.js';
import { pickNextMessage } from './pickup.js';

export interface InboxPollerOptions {
  /** Principal whose inbox to pick from. */
  readonly principal: PrincipalId;
  /**
   * Callback invoked for each picked message. Errors thrown here are
   * caught and logged (via the `onError` hook) so a handler crash
   * doesn't tear down the polling loop.
   */
  readonly onMessage: (outcome: Extract<PickupOutcome, { kind: 'picked' }>) => Promise<void> | void;
  /**
   * Optional error callback. Defaults to console.error.
   */
  readonly onError?: (err: unknown) => void;
  /**
   * Correctness poll interval in ms. Defaults to 30_000 (matches
   * pol-inbox-poll-cadence default). Consumers can read the actual
   * policy atom and pass its current value.
   */
  readonly correctnessPollMs?: number;
  /**
   * Faster cadence engaged when a deadline-imminent message is
   * visible. Defaults to 5_000. When the hybrid-wake seam is wired
   * to a real push channel, this value is the floor of
   * "latency-while-deadlines-loom."
   */
  readonly deadlineImminentPollMs?: number;
  /**
   * AbortSignal for graceful shutdown. The poller stops polling and
   * unsubscribes when aborted.
   */
  readonly signal?: AbortSignal;
  /**
   * Pickup options forwarded to `pickNextMessage`. Useful for
   * wiring the `.lag/STOP` sentinel and custom ordering functions.
   */
  readonly pickupOptions?: PickupOptions;
}

/**
 * Run the poller until `signal` is aborted. Returns a promise that
 * resolves when the loop exits (normal abort) or rejects on an
 * unrecoverable setup error.
 */
export async function runInboxPoller(
  host: Host,
  options: InboxPollerOptions,
): Promise<void> {
  const onError = options.onError ?? ((err) => {
    // eslint-disable-next-line no-console
    console.error('[InboxPoller]', err);
  });
  const pollMs = options.correctnessPollMs ?? 30_000;
  const deadlineFastMs = options.deadlineImminentPollMs ?? 5_000;

  const runOne = async () => {
    if (options.signal?.aborted) return { exited: true };
    try {
      const outcome = await pickNextMessage(host, options.principal, options.pickupOptions);
      if (outcome.kind === 'kill-switch') {
        // Honor the sentinel at the polling layer too: stop the loop
        // until the operator clears STOP. Next-tick iterations just
        // re-return kill-switch; wait longer.
        return { exited: false, picked: false };
      }
      if (outcome.kind === 'picked') {
        try {
          await options.onMessage(outcome);
        } catch (err) {
          onError(err);
        }
        return { exited: false, picked: true };
      }
      return { exited: false, picked: false };
    } catch (err) {
      onError(err);
      return { exited: false, picked: false };
    }
  };

  // Hybrid-wake path: if the store declares subscribe, race an event
  // wake against the correctness-poll timer. Default-poll-only if not.
  const hasSubscribe = host.atoms.capabilities?.hasSubscribe === true
    && typeof host.atoms.subscribe === 'function';

  while (!options.signal?.aborted) {
    const pickResult = await runOne();
    if (pickResult.exited) break;

    // If we just picked something, drain greedily: there may be more
    // messages queued. Only sleep/wait when the inbox is idle.
    if (pickResult.picked) continue;

    const sleepMs = await computeSleepMs(
      host,
      options.principal,
      pollMs,
      deadlineFastMs,
    );

    if (hasSubscribe) {
      await waitForWakeOrTimeout(host, options.principal, sleepMs, options.signal);
    } else {
      await sleepWithAbort(sleepMs, options.signal);
    }
  }
}

/**
 * Compute the time to sleep until the next poll. Returns the
 * deadline-imminent cadence if any unacked message has a near
 * deadline; otherwise the correctness-poll cadence.
 */
async function computeSleepMs(
  host: Host,
  principalId: PrincipalId,
  correctnessPollMs: number,
  deadlineFastMs: number,
): Promise<number> {
  // Cheap: reuse the listUnread path. If any message carries a
  // deadline_ts within the fast-cadence threshold, shorten the sleep.
  try {
    const { listUnread } = await import('./inbox-reader.js');
    const unread = await listUnread(host, principalId);
    // Use host.clock (not Date.now) so virtualized/replayed time
    // in tests or time-shifted adapters produces deterministic
    // cadence decisions. Per the Host-interface boundary rule.
    const nowIso = host.clock.now();
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) return correctnessPollMs;
    for (const m of unread) {
      const deadline = m.envelope.deadline_ts;
      if (deadline === undefined) continue;
      const t = Date.parse(deadline);
      if (Number.isFinite(t) && (t - nowMs) <= 60_000) {
        return Math.min(correctnessPollMs, deadlineFastMs);
      }
    }
  } catch {
    // On any listUnread failure fall through to the slow cadence.
  }
  return correctnessPollMs;
}

/**
 * Wait for either (a) a subscribe event, (b) `timeoutMs` elapsed,
 * (c) the signal aborted. Returns as soon as any fires. Guarantees
 * that a pending subscribe subscription is unwound before returning.
 */
async function waitForWakeOrTimeout(
  host: Host,
  principalId: PrincipalId,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const subscribe = host.atoms.subscribe;
  if (subscribe === undefined) {
    return sleepWithAbort(timeoutMs, signal);
  }
  const subAbort = new AbortController();
  const cancelAll = () => {
    try { subAbort.abort(); } catch { /* ignore */ }
  };
  const outerAbortListener = () => cancelAll();
  signal?.addEventListener('abort', outerAbortListener, { once: true });

  const timeoutPromise = new Promise<void>((r) => {
    const off = () => {
      clearTimeout(t);
      // Remove BOTH abort listeners so a normal timeout does not
      // leave stale callbacks dangling off the signals. Without
      // this, each idle cycle retains two callbacks per signal and
      // shutdown walks them all.
      signal?.removeEventListener('abort', off);
      subAbort.signal.removeEventListener('abort', off);
      r();
    };
    const t = setTimeout(off, timeoutMs);
    signal?.addEventListener('abort', off, { once: true });
    subAbort.signal.addEventListener('abort', off, { once: true });
  });

  const eventPromise = (async () => {
    try {
      // AtomFilter cannot express metadata.actor_message.to today, so
      // we subscribe by type and filter recipient at the consumer
      // side by re-fetching the atom. Extra read per event, but
      // correct, and avoids waking N inbox pollers on every write.
      // Adapters that add recipient-level filtering in a future PR
      // can have their AtomFilter extended; the poller will use
      // whatever the filter supports without a code change here.
      for await (const ev of subscribe.call(host.atoms, { type: ['actor-message'] }, subAbort.signal)) {
        if (ev.kind !== 'put' && ev.kind !== 'update') continue;
        const atom = await host.atoms.get(ev.atomId);
        if (atom === null) continue;
        const to = (atom.metadata as { actor_message?: { to?: string } })?.actor_message?.to;
        if (to === String(principalId)) return;
      }
    } catch {
      // Subscription failure -> fall back to waiting out the timer.
    }
  })();

  try {
    await Promise.race([timeoutPromise, eventPromise]);
  } finally {
    cancelAll();
    signal?.removeEventListener('abort', outerAbortListener);
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const cancel = () => {
      clearTimeout(t);
      // Remove the abort listener on BOTH paths (normal timeout and
      // abort). Without this the poll loop accumulates one stale
      // listener per idle cycle, which is a slow memory leak and
      // makes shutdown walk a growing callback list.
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const t = setTimeout(cancel, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
