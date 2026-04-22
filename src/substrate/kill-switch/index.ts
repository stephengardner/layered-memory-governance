/**
 * Kill-switch primitive: an AbortSignal that trips on a filesystem
 * sentinel, on any of a set of parent AbortSignals, or at construction
 * if the sentinel is already present.
 *
 * Shape:
 *   const ks = createKillSwitch({ stateDir, sentinelFilename?,
 *     additionalAbortSignals?, pollFallbackMs? });
 *   // pass ks.signal into every async call that supports it:
 *   //   fetch(url, { signal: ks.signal })
 *   //   child_process.spawn(bin, args, { signal: ks.signal })
 *   //   execa(bin, args, { cancelSignal: ks.signal })
 *   // eventually:
 *   ks.dispose();
 *
 * Trip paths (first-wins):
 *   1. stop-sentinel: fs.watch on stateDir filtered to sentinelFilename,
 *      with a redundant setInterval stat() fallback because some
 *      filesystems drop watch events silently.
 *   2. parent-signal: any AbortSignal passed via additionalAbortSignals
 *      that aborts post-construction.
 *   3. already-present: sentinel existing at construction trips
 *      synchronously before returning.
 *
 * Once tripped, signal.reason is a KillSwitchAbortReason describing
 * the trigger. dispose() is idempotent and does not itself trip the
 * signal; callers wanting a programmatic trip abort one of the
 * additionalAbortSignals they passed in.
 *
 * The module stays mechanism-only: it knows nothing about which actors
 * use it, which adapters subscribe, which atoms get written on trip,
 * or which higher-level loop composes it. Those concerns live in
 * canon, skills, and the specific actor/adapter modules that compose
 * this primitive.
 */

import {
  existsSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { resolve } from 'node:path';

export type KillSwitchTrigger = 'stop-sentinel' | 'parent-signal';

export interface KillSwitchController {
  /**
   * AbortSignal that every adapter, HTTP client, and child
   * process in the actor's subtree is expected to subscribe to.
   * Aborts with reason set to a KillSwitchAbortReason object
   * describing what tripped the switch.
   */
  readonly signal: AbortSignal;

  /** True once any trip path has fired. */
  readonly tripped: boolean;

  /**
   * What tripped the switch, or null if not tripped yet.
   * Observable so consumers can include the trigger in the
   * kill-switch-tripped atom's metadata.
   */
  readonly trippedBy: KillSwitchTrigger | null;

  /**
   * Stop watching the sentinel, drop the poll interval, and
   * release the parent-signal subscription. Idempotent. Does NOT
   * abort the signal; callers that want to force a programmatic
   * trip should abort one of the `additionalAbortSignals` they
   * passed in at construction.
   */
  dispose(): void;
}

export interface KillSwitchAbortReason {
  readonly kind: 'kill-switch';
  readonly trigger: KillSwitchTrigger;
  readonly trippedAt: string;
  readonly sentinelPath: string;
}

export interface CreateKillSwitchOptions {
  /**
   * Root directory the sentinel lives under (typically the
   * `.lag/` state dir of the host). Required; there is no
   * default because the correct value depends on deployment
   * topology and a silent default would hide a wiring mistake.
   */
  readonly stateDir: string;

  /** Defaults to 'STOP'. */
  readonly sentinelFilename?: string;

  /**
   * Additional AbortSignals to compose with. When any of these
   * aborts, the kill switch trips with trigger='parent-signal'.
   * Typical use: process-level SIGTERM -> AbortSignal adapter.
   */
  readonly additionalAbortSignals?: ReadonlyArray<AbortSignal>;

  /**
   * Polling interval (ms) for the stat-based fallback path.
   * Some filesystems drop `fs.watch` events silently (network
   * shares, Windows via certain watch APIs, Docker bind mounts).
   * The poll fallback caps worst-case detection latency at this
   * value. Defaults to 1000 ms.
   */
  readonly pollFallbackMs?: number;
}

const DEFAULT_SENTINEL = 'STOP';
const DEFAULT_POLL_MS = 1000;

export function createKillSwitch(
  options: CreateKillSwitchOptions,
): KillSwitchController {
  if (!options.stateDir || options.stateDir.length === 0) {
    throw new Error(
      '[kill-switch] createKillSwitch requires a non-empty stateDir',
    );
  }

  const sentinelFilename = options.sentinelFilename ?? DEFAULT_SENTINEL;
  // Reject anything that could resolve outside stateDir. `fs.watch`
  // below only observes stateDir; an out-of-root sentinel silently
  // breaks the kill-switch contract. Narrow acceptance: a single
  // filename component (no slash / backslash / drive prefix / dot).
  if (
    sentinelFilename.length === 0
    || sentinelFilename === '.'
    || sentinelFilename === '..'
    || /[\\/]/u.test(sentinelFilename)
    || /^[A-Za-z]:/u.test(sentinelFilename)
  ) {
    throw new Error(
      '[kill-switch] sentinelFilename must be a single filename under stateDir',
    );
  }
  const sentinelPath = resolve(options.stateDir, sentinelFilename);
  const pollMs = options.pollFallbackMs ?? DEFAULT_POLL_MS;
  // pollFallbackMs drives setInterval. Non-finite, non-integer, or
  // non-positive values either throw at setInterval time or yield
  // unexpected behaviour (Infinity, NaN, 0). Validate up-front so the
  // failure surfaces at construction, not silently later.
  if (
    typeof pollMs !== 'number'
    || !Number.isFinite(pollMs)
    || !Number.isInteger(pollMs)
    || pollMs <= 0
  ) {
    throw new Error(
      '[kill-switch] pollFallbackMs must be a finite positive integer (milliseconds)',
    );
  }

  const controller = new AbortController();

  let tripped = false;
  let trippedBy: KillSwitchTrigger | null = null;
  let disposed = false;
  let watcher: FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  const parentUnsubscribers: Array<() => void> = [];

  // One shared trip function so every trigger path converges
  // and the first-wins semantics are deterministic.
  function trip(trigger: KillSwitchTrigger): void {
    if (tripped) return;
    tripped = true;
    trippedBy = trigger;
    const reason: KillSwitchAbortReason = {
      kind: 'kill-switch',
      trigger,
      trippedAt: new Date().toISOString(),
      sentinelPath,
    };
    controller.abort(reason);
    // Triggering is terminal; we can safely drop the watchers
    // so we don't burn CPU after the actor has started its
    // tear-down.
    teardown();
  }

  function teardown(): void {
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        // fs.watch.close can throw on some platforms if already
        // closed; safe to ignore here.
      }
      watcher = null;
    }
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const unsub of parentUnsubscribers) {
      try {
        unsub();
      } catch {
        // Parent-signal removeEventListener can reasonably
        // throw on disposed AbortSignals in odd runtimes; we
        // just want the subscription gone.
      }
    }
    parentUnsubscribers.length = 0;
  }

  // 1. Immediate check: if the sentinel already exists, trip
  //    before returning the controller. Caller sees
  //    signal.aborted === true immediately.
  if (existsSync(sentinelPath)) {
    trip('stop-sentinel');
    return buildController();
  }

  // 2. fs.watch on the containing directory, filtered to the
  //    sentinel filename. `rename` covers create + delete;
  //    `change` covers in-place overwrite. A defensive
  //    existsSync re-check guards against stale events.
  try {
    watcher = watch(options.stateDir, (eventType, filename) => {
      if (disposed || tripped) return;
      // filename may be null on some platforms; in that case we
      // just re-check the sentinel unconditionally.
      if (filename !== null && filename !== sentinelFilename) return;
      if (existsSync(sentinelPath)) trip('stop-sentinel');
    });
    // fs.watch itself can throw post-creation (ENOSPC on Linux
    // when inotify instances are exhausted). Route those to the
    // polling fallback.
    watcher.on('error', () => {
      if (watcher !== null) {
        try {
          watcher.close();
        } catch {
          // already closed; ignore
        }
        watcher = null;
      }
    });
  } catch {
    // Watch registration failed outright (e.g., stateDir does
    // not exist yet). Polling fallback still delivers the trip
    // on latency budget.
    watcher = null;
  }

  // 3. setInterval poll fallback. Redundant with fs.watch by
  //    design: some filesystems drop watch events silently.
  //    `unref()` so the interval does not prevent the process
  //    from exiting when everything else is done.
  pollTimer = setInterval(() => {
    if (disposed || tripped) return;
    if (existsSync(sentinelPath)) trip('stop-sentinel');
  }, pollMs);
  pollTimer.unref();

  // 4. Compose with parent AbortSignals. If any of them is
  //    already aborted at construction, trip now; otherwise
  //    register a one-shot listener that trips on their abort.
  const parents = options.additionalAbortSignals ?? [];
  for (const parent of parents) {
    if (parent.aborted) {
      trip('parent-signal');
      break;
    }
    const onAbort = () => trip('parent-signal');
    parent.addEventListener('abort', onAbort, { once: true });
    parentUnsubscribers.push(() => parent.removeEventListener('abort', onAbort));
  }

  return buildController();

  function buildController(): KillSwitchController {
    return {
      signal: controller.signal,
      get tripped() {
        return tripped;
      },
      get trippedBy() {
        return trippedBy;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        teardown();
      },
    };
  }
}

/**
 * Type guard: checks whether an AbortSignal's abort reason is a
 * KillSwitchAbortReason. Useful for adapters that want to
 * distinguish a kill-switch abort from other AbortSignal users.
 */
export function isKillSwitchAbortReason(
  reason: unknown,
): reason is KillSwitchAbortReason {
  if (typeof reason !== 'object' || reason === null) return false;
  const r = reason as Record<string, unknown>;
  // Validate every field the KillSwitchAbortReason interface declares
  // before narrowing. A third-party AbortSignal that happens to carry
  // `{ kind: 'kill-switch' }` but lacks `trigger` / `trippedAt` /
  // `sentinelPath` would otherwise satisfy the type guard and then
  // crash a consumer that dereferences the missing fields. Validate
  // shape, not just discriminant.
  if (r.kind !== 'kill-switch') return false;
  if (typeof r.trigger !== 'string') return false;
  if (typeof r.trippedAt !== 'string') return false;
  if (typeof r.sentinelPath !== 'string') return false;
  return true;
}
