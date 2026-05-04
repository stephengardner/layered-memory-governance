// Pure helper for the approval-cycle daemon-mode loop. Extracted into
// a shebang-free module so the test can static-import without
// triggering the script's CLI side effects (mirrors the pattern from
// approval-cycle-gate.mjs + git-as-push-auth.mjs +
// update-branch-decider.mjs).
//
// The CLI driver in scripts/run-approval-cycle.mjs supplies:
//   - runOnce: () => Promise<void>      one approval-cycle pass
//   - readIntervalMs: () => Promise<number>   reads canon
//   - sleep: (ms, signal?) => Promise<void>   default uses setTimeout
//   - signal: AbortSignal              SIGTERM/SIGINT path
//   - onError?: (err) => void          default logs to stderr
//   - minimumMs?: number               clamp floor; default 1000
//   - maxIterations?: number           test-only cap; default Infinity
//
// The helper guarantees:
//   1. runOnce errors are contained (never tear down the loop).
//   2. The interval is read fresh BEFORE each sleep so a canon edit
//      takes effect on the very next pass without a daemon restart.
//   3. AbortSignal cuts a sleep cleanly so ctrl-C does not block on
//      a full interval.
//   4. A malformed (NaN, <=0) intervalMs is clamped to minimumMs so
//      a custom reader cannot wedge the loop into a busy-spin.

const DEFAULT_MINIMUM_MS = 1_000;

/**
 * Default sleep: setTimeout-backed; resolves early on signal abort.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Drive runOnce on a recurring schedule. Returns a Promise that
 * resolves when the signal aborts (or maxIterations is exhausted in
 * tests). NEVER throws; runOnce errors are routed through onError.
 *
 * @param {{
 *   runOnce: () => Promise<void>,
 *   readIntervalMs: () => Promise<number>,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   signal: AbortSignal,
 *   onError?: (err: unknown) => void,
 *   minimumMs?: number,
 *   maxIterations?: number,
 * }} args
 * @returns {Promise<void>}
 */
export async function runDaemonLoop(args) {
  const sleep = args.sleep ?? defaultSleep;
  const onError = args.onError ?? ((err) => {
    // Best-effort stderr; the daemon already logs per-tick failures
    // before they bubble here, so onError is the last-resort hook.
    console.error(`[approval-cycle:daemon] iteration error: ${err?.message ?? err}`);
  });
  const minimumMs = args.minimumMs ?? DEFAULT_MINIMUM_MS;
  const maxIterations = args.maxIterations ?? Number.POSITIVE_INFINITY;
  const signal = args.signal;

  let i = 0;
  while (!signal.aborted && i < maxIterations) {
    try {
      await args.runOnce();
    } catch (err) {
      try {
        onError(err);
      } catch {
        // onError must not throw past us; if it does, swallow so the
        // loop continues. The whole point of containment is that the
        // operator-facing daemon never silently exits on an error.
      }
    }
    i += 1;
    if (signal.aborted) break;
    if (i >= maxIterations) break;
    let intervalMs;
    try {
      intervalMs = await args.readIntervalMs();
    } catch (err) {
      try { onError(err); } catch { /* swallow */ }
      intervalMs = minimumMs;
    }
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs < minimumMs) {
      intervalMs = minimumMs;
    }
    await sleep(intervalMs, signal);
  }
}
