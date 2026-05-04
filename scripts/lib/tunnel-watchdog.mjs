// Pure helpers for scripts/tunnel-watchdog.mjs. Extracted to a
// shebang-free module so vitest on Windows-CI can static-import them
// from a .test.ts (importing a `#!`-headed `.mjs` from a transpiled
// test file fails with "Invalid or unexpected token" at line 1; the
// same split-pattern shipped for cr-precheck and update-branch-if-stale
// after PR #123 made the cause concrete).
//
// No I/O, no spawn, no clock reads. Each export is a pure function over
// its arguments so unit tests cover every branch without standing up a
// real cloudflared process or a live HTTP server.

/**
 * Parse a `*.trycloudflare.com` hostname out of a chunk of cloudflared
 * stdout/stderr. cloudflared logs the assigned URL exactly once per
 * tunnel start, formatted variously across versions; we tolerate any
 * line that contains a URL whose host ends with `.trycloudflare.com`.
 *
 * Returns the bare host (e.g. `example-foo-bar.trycloudflare.com`),
 * NOT the full URL. The caller decides which protocol prefix to use
 * when adding it to LAG_CONSOLE_ALLOWED_ORIGINS.
 *
 * Returns null if no host appears in the input. Multiple hosts in one
 * chunk: the FIRST match wins, matching cloudflared's "log once at
 * startup" shape; if a future cloudflared logs the host on every
 * keepalive, the first occurrence is still the one we want (it is the
 * actual tunnel URL, not a heartbeat echo of it).
 *
 * Defensive: cloudflared has historically logged ANSI colour codes
 * around the URL on TTY-attached runs, so we strip the surrounding
 * decoration before regex-matching.
 */
export function parseTrycloudflareHostname(chunk) {
  if (typeof chunk !== 'string' || chunk.length === 0) return null;
  // Strip ANSI escape sequences (CSI / SGR). cloudflared on Windows
  // sometimes emits these even with --no-tls-verify and friends.
  const stripped = chunk.replace(/\x1B\[[0-9;]*m/g, '');
  const match = stripped.match(/https?:\/\/([a-z0-9][a-z0-9-]*\.trycloudflare\.com)/i);
  if (!match) return null;
  // Lowercase the host: DNS is case-insensitive and the allowlist
  // compares with a case-sensitive Set in the security helper.
  return match[1].toLowerCase();
}

/**
 * Compute the next backoff delay (ms) for a sequence of consecutive
 * failures. Exponential with a jitter cap: base * 2^failures, clamped
 * to maxMs, then jittered uniformly within +/-jitterFraction of the
 * computed value.
 *
 * The formula is deterministic given a `random` injection (default
 * Math.random) so tests can pin the jitter without flakes. failures=0
 * returns base * (1 +/- jitter); the first retry is not zero-delay,
 * which prevents a hot-loop when a cloudflared process exits the
 * instant it spawns.
 *
 * Inputs out of range (negative failures, baseMs<=0, maxMs<base,
 * jitterFraction<0 or >=1) clamp to safe defaults rather than throw.
 * The watchdog's failure path must not itself fail-closed on a math
 * edge; a returned 1000ms delay is always survivable.
 */
export function nextBackoffMs(opts) {
  const baseMs = Number.isFinite(opts?.baseMs) && opts.baseMs > 0 ? opts.baseMs : 1000;
  const maxMs = Number.isFinite(opts?.maxMs) && opts.maxMs >= baseMs ? opts.maxMs : 60_000;
  const failures = Number.isFinite(opts?.failures) && opts.failures >= 0 ? Math.floor(opts.failures) : 0;
  const jitterFraction = Number.isFinite(opts?.jitterFraction) && opts.jitterFraction >= 0 && opts.jitterFraction < 1
    ? opts.jitterFraction
    : 0.2;
  const random = typeof opts?.random === 'function' ? opts.random : Math.random;
  // 2^failures grows fast; cap exponent at 20 (~17min if base=1s) to
  // keep the math stable on JS doubles. The maxMs clamp below caps
  // the actual return value much sooner in practice.
  const exp = Math.min(failures, 20);
  const raw = baseMs * Math.pow(2, exp);
  const clamped = Math.min(raw, maxMs);
  // Jitter both directions so the backoff schedule does not produce a
  // synchronized retry storm if many supervisors restart together.
  const jitter = (random() * 2 - 1) * jitterFraction;
  const jittered = Math.max(0, clamped * (1 + jitter));
  return Math.floor(jittered);
}

/**
 * Circuit-breaker decision: should we attempt yet another restart of
 * the supervised component?
 *
 * Trips when failures >= threshold AND the tripped state has not been
 * cleared (a successful run resets the count via the caller). Once
 * tripped, the breaker stays open until the caller observes a manual
 * reset OR the cooldown elapses; both paths exist so a fundamentally
 * broken upstream does not pin CPU at the watchdog tier.
 *
 * Returns one of three verdicts:
 *   - 'attempt'   : within budget; spawn another restart.
 *   - 'cooldown'  : tripped but cooldown not yet expired; wait and
 *                   re-check on the next tick rather than spawning.
 *   - 'tripped'   : tripped and cooldown disabled (cooldownMs <= 0);
 *                   caller decides whether to halt or escalate.
 */
export function decideRestartAction(state) {
  const failures = Number.isFinite(state?.failures) && state.failures >= 0
    ? Math.floor(state.failures)
    : 0;
  const threshold = Number.isFinite(state?.threshold) && state.threshold > 0
    ? Math.floor(state.threshold)
    : 5;
  const cooldownMs = Number.isFinite(state?.cooldownMs) && state.cooldownMs >= 0
    ? state.cooldownMs
    : 0;
  const lastTripAt = Number.isFinite(state?.lastTripAt) ? state.lastTripAt : null;
  const now = Number.isFinite(state?.now) ? state.now : Date.now();

  if (failures < threshold) return { verdict: 'attempt', reason: 'within-budget' };
  if (cooldownMs <= 0) return { verdict: 'tripped', reason: 'breaker-open-no-cooldown' };
  if (lastTripAt === null) return { verdict: 'cooldown', reason: 'breaker-open-cooldown-pending' };
  const elapsed = now - lastTripAt;
  if (elapsed < cooldownMs) return { verdict: 'cooldown', reason: 'breaker-open-cooldown-active' };
  // Cooldown has elapsed: caller resets failures to 0 (or to threshold-1
  // in a half-open variant) and we attempt one probe.
  return { verdict: 'attempt', reason: 'cooldown-elapsed' };
}

/**
 * Classify a probe outcome into 'healthy' / 'unhealthy' so the
 * watchdog's main loop can branch deterministically. Pure: caller
 * passes the observed shape; we encode the policy table once.
 *
 * The probe surfaces three distinguishing signals:
 *   - status: numeric HTTP status from the probe (0 = no response).
 *   - error: a string error code (ECONNREFUSED, ETIMEDOUT, ENOTFOUND,
 *            502, ...). Empty/undefined means "no error".
 *   - bodyMarker: optional substring the caller expected to see in
 *            the response body. Presence is healthy; absence falls
 *            through to status-only.
 *
 * 502 and ECONNREFUSED are the canonical "upstream crashed" signatures
 * for a cloudflared quick-tunnel. We treat 5xx as unhealthy regardless
 * of cause; if the upstream is healthy but returning 5xx, the watchdog
 * restarting it is the correct response (the 5xx is itself a bug we
 * want to bounce out of).
 */
export function classifyProbe(probe) {
  if (!probe || typeof probe !== 'object') return { status: 'unhealthy', reason: 'no-probe-result' };
  const error = typeof probe.error === 'string' ? probe.error : '';
  if (error === 'ECONNREFUSED' || error === 'ETIMEDOUT' || error === 'ENOTFOUND' || error === 'ECONNRESET') {
    return { status: 'unhealthy', reason: `network-${error.toLowerCase()}` };
  }
  const status = Number.isFinite(probe.status) ? probe.status : 0;
  if (status === 0) return { status: 'unhealthy', reason: 'no-response' };
  if (status >= 500 && status < 600) return { status: 'unhealthy', reason: `http-${status}` };
  if (status >= 400 && status < 500) {
    // 4xx is "you asked the wrong thing" not "the server is down". A
    // healthy server that returns 404 on the probe path is still up;
    // the caller chose the wrong path. Treat as healthy and let the
    // operator notice via logs.
    return { status: 'healthy', reason: `http-${status}-not-server-fault` };
  }
  if (typeof probe.bodyMarker === 'string' && probe.bodyMarker.length > 0) {
    const body = typeof probe.body === 'string' ? probe.body : '';
    if (!body.includes(probe.bodyMarker)) {
      return { status: 'unhealthy', reason: 'body-marker-missing' };
    }
  }
  return { status: 'healthy', reason: `http-${status}` };
}

/**
 * Decide what the periodic probe loop should do for a single component
 * based on the classified probe status and whether a live child is
 * currently supervising the port. Pure: takes the inputs, returns the
 * action; the caller wires the side effects.
 *
 * The policy this encodes (Finding 3): the EXIT handler is the single
 * place that increments failures after an actual child exit; the probe
 * loop only increments failures when there is no live child to kill
 * (otherwise SIGTERM produces an exit event that hits the increment
 * site, causing double-counting). Healthy probes reset failures to 0
 * so transient blips do not accumulate toward the breaker.
 *
 * Returns one of four actions:
 *   - 'reset'    : healthy probe, caller should set failures = 0.
 *   - 'noop'     : a restart is already pending for this component.
 *   - 'sigterm'  : unhealthy probe with a live child; caller should
 *                  SIGTERM the child and let the exit handler bump
 *                  failures + schedule the restart.
 *   - 'schedule' : unhealthy probe with NO live child; caller should
 *                  bump failures and call scheduleRestart directly.
 */
export function decideProbeAction(input) {
  const probeStatus = input?.probeStatus;
  const restarting = input?.restarting === true;
  const hasLiveChild = input?.hasLiveChild === true;
  if (probeStatus === 'healthy') return { action: 'reset' };
  if (restarting) return { action: 'noop' };
  if (hasLiveChild) return { action: 'sigterm' };
  return { action: 'schedule' };
}

/**
 * Decide whether a setTimeout-driven restart callback should proceed
 * or bail out as stale. The watchdog captures the child handle and a
 * monotonically-incrementing generation counter at scheduling time;
 * if a different code path (e.g. handleNewTunnelHost rotation) has
 * since replaced state.child or bumped the generation, the queued
 * timer must skip the respawn rather than create a second child that
 * collides on the port (Finding 2).
 *
 * Returns one of three actions:
 *   - 'shutdown' : the watchdog is shutting down; abandon the restart.
 *   - 'stale'    : the captured child or generation no longer matches
 *                  the live state; abandon the restart.
 *   - 'proceed'  : the captured snapshot still matches; respawn.
 */
export function decideRestartTimerAction(input) {
  if (input?.shuttingDown === true) return { action: 'shutdown' };
  const expectedChild = input?.expectedChild;
  const expectedGeneration = input?.expectedGeneration;
  const currentChild = input?.currentChild;
  const currentGeneration = input?.currentGeneration;
  if (currentChild !== expectedChild) return { action: 'stale', reason: 'child-changed' };
  if (currentGeneration !== expectedGeneration) return { action: 'stale', reason: 'generation-changed' };
  return { action: 'proceed' };
}

/**
 * Merge a freshly-discovered tunnel hostname into an existing
 * LAG_CONSOLE_ALLOWED_ORIGINS env value. Returns the new env value AND
 * a boolean indicating whether the value actually changed (so the
 * caller can decide whether a 9081 server restart is warranted).
 *
 * Defensive normalization:
 *   - We add BOTH `https://<host>` and `http://<host>` so a tunnel
 *     hit over plain http (rare but legal for trycloudflare) stays
 *     allowed.
 *   - Deduplication is whitespace-tolerant and order-preserving; the
 *     existing entries keep their position, the new entries append.
 *   - Empty/undefined existing value parses as no entries (not
 *     `['']`), preventing a leading comma in the merged result.
 */
export function mergeAllowedOrigins(existing, newHost) {
  if (typeof newHost !== 'string' || newHost.length === 0) {
    return { value: existing ?? '', changed: false };
  }
  const entries = (existing ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(entries);
  const additions = [];
  for (const proto of ['https', 'http']) {
    const candidate = `${proto}://${newHost}`;
    if (!seen.has(candidate)) {
      additions.push(candidate);
      seen.add(candidate);
    }
  }
  if (additions.length === 0) {
    return { value: entries.join(','), changed: false };
  }
  const merged = [...entries, ...additions].join(',');
  return { value: merged, changed: true };
}
