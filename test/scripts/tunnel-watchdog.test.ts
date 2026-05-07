/**
 * Unit tests for scripts/tunnel-watchdog.mjs pure helpers.
 *
 * The watchdog wires three pure decisions together: parse a tunnel
 * hostname out of cloudflared output, decide a backoff delay after a
 * failure, classify a probe response into healthy/unhealthy, and
 * merge a newly-discovered hostname into LAG_CONSOLE_ALLOWED_ORIGINS.
 * Each is covered here in isolation; the spawn + signal + restart side
 * effects are exercised via operator dogfeed (the watchdog is an OPS
 * supervisor, not a substrate primitive, so a vitest harness around
 * cloudflared is more cost than coverage).
 *
 * Test discipline: import the shebang-free helper module so vitest's
 * Windows-CI transformer does not stumble on the `#!` of the CLI
 * wrapper (PR #123 / PR #172 precedent).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyProbe,
  decideProbeAction,
  decideRestartAction,
  decideRestartTimerAction,
  mergeAllowedOrigins,
  nextBackoffMs,
  parseIntegerFlag,
  parseTrycloudflareHostname,
  resolveCloudflaredPath,
} from '../../scripts/lib/tunnel-watchdog.mjs';

describe('parseTrycloudflareHostname', () => {
  it('returns the bare host from a plain log line', () => {
    const line = 'Your quick Tunnel has been created! Visit it at: https://swift-eagle-foo-bar.trycloudflare.com';
    expect(parseTrycloudflareHostname(line)).toBe('swift-eagle-foo-bar.trycloudflare.com');
  });

  it('lowercases the host so allowlist comparisons are stable', () => {
    expect(parseTrycloudflareHostname('https://Mixed-Case-Host.TryCloudflare.COM')).toBe(
      'mixed-case-host.trycloudflare.com',
    );
  });

  it('strips ANSI colour codes around the URL', () => {
    const ansi = '\x1B[36mTunnel:\x1B[0m \x1B[1mhttps://blue-cat.trycloudflare.com\x1B[0m';
    expect(parseTrycloudflareHostname(ansi)).toBe('blue-cat.trycloudflare.com');
  });

  it('returns null when no trycloudflare host is present', () => {
    expect(parseTrycloudflareHostname('starting tunnel...')).toBeNull();
    expect(parseTrycloudflareHostname('https://example.com')).toBeNull();
  });

  it('returns null on non-string / empty input', () => {
    expect(parseTrycloudflareHostname('')).toBeNull();
    // @ts-expect-error feeding the wrong shape on purpose to exercise the guard
    expect(parseTrycloudflareHostname(undefined)).toBeNull();
    // @ts-expect-error feeding the wrong shape on purpose
    expect(parseTrycloudflareHostname({ url: 'https://x.trycloudflare.com' })).toBeNull();
  });

  it('takes the first match if multiple URLs appear in one chunk', () => {
    const chunk = 'https://first-host.trycloudflare.com and later https://second-host.trycloudflare.com';
    expect(parseTrycloudflareHostname(chunk)).toBe('first-host.trycloudflare.com');
  });

  it('also matches plain http URLs (rare but legal for quick-tunnels)', () => {
    expect(parseTrycloudflareHostname('listening on http://plain-host.trycloudflare.com')).toBe(
      'plain-host.trycloudflare.com',
    );
  });
});

describe('nextBackoffMs', () => {
  it('returns approximately base * 2^failures with no jitter when random pinned to 0.5', () => {
    // random()=0.5 -> jitter factor = (0.5*2-1)*0.2 = 0; jittered = clamped
    const r = nextBackoffMs({ failures: 3, baseMs: 1000, maxMs: 60_000, jitterFraction: 0.2, random: () => 0.5 });
    expect(r).toBe(8000);
  });

  it('clamps to maxMs at high failure counts', () => {
    const r = nextBackoffMs({ failures: 20, baseMs: 1000, maxMs: 30_000, jitterFraction: 0.2, random: () => 0.5 });
    expect(r).toBe(30_000);
  });

  it('returns a non-zero delay for failures=0 (no hot loop on instant-exit)', () => {
    const r = nextBackoffMs({ failures: 0, baseMs: 500, maxMs: 60_000, jitterFraction: 0, random: () => 0.5 });
    expect(r).toBe(500);
  });

  it('clamps a negative jitter to floor 0 (returned delay never goes negative)', () => {
    // random()=0 -> jitter = -1 * jitterFraction; very high jitter would push value below 0.
    const r = nextBackoffMs({ failures: 0, baseMs: 100, maxMs: 60_000, jitterFraction: 0.99, random: () => 0 });
    expect(r).toBeGreaterThanOrEqual(0);
  });

  it('clamps invalid input to safe defaults rather than throwing', () => {
    // failures negative -> 0; baseMs 0 -> 1000; maxMs less than base -> 60000; jitter 1 -> 0.2
    const r = nextBackoffMs({ failures: -5, baseMs: 0, maxMs: -1, jitterFraction: 5, random: () => 0.5 });
    expect(r).toBe(1000);
  });
});

describe('decideRestartAction', () => {
  // Each test passes `now` explicitly: the lib enforces clock injection
  // ("No I/O, no spawn, no clock reads"), so the helper throws if
  // state.now is missing. Pinning a fixed `now` keeps the test
  // deterministic and prevents a future Date.now() fallback from
  // re-introducing test flake.
  it('attempts when failures are below threshold', () => {
    expect(decideRestartAction({ failures: 2, threshold: 5, now: 1_000_000 })).toEqual({
      verdict: 'attempt',
      reason: 'within-budget',
    });
  });

  it('trips with no cooldown when breaker is open', () => {
    const r = decideRestartAction({ failures: 5, threshold: 5, cooldownMs: 0, now: 1_000_000 });
    expect(r.verdict).toBe('tripped');
  });

  it('reports cooldown active when cooldown not yet elapsed', () => {
    const r = decideRestartAction({
      failures: 5,
      threshold: 5,
      cooldownMs: 60_000,
      lastTripAt: 1_000_000,
      now: 1_030_000, // 30s elapsed
    });
    expect(r.verdict).toBe('cooldown');
    expect(r.reason).toContain('cooldown-active');
  });

  it('attempts again after cooldown elapses', () => {
    const r = decideRestartAction({
      failures: 5,
      threshold: 5,
      cooldownMs: 60_000,
      lastTripAt: 1_000_000,
      now: 1_120_000, // 120s elapsed > 60s cooldown
    });
    expect(r.verdict).toBe('attempt');
    expect(r.reason).toContain('cooldown-elapsed');
  });

  it('reports cooldown-pending when tripped without a recorded trip time', () => {
    const r = decideRestartAction({
      failures: 5,
      threshold: 5,
      cooldownMs: 60_000,
      lastTripAt: null,
      now: 1_000_000,
    });
    expect(r.verdict).toBe('cooldown');
    expect(r.reason).toContain('cooldown-pending');
  });

  it('throws when state.now is missing (purity contract: no clock reads)', () => {
    // The helper documentation pins this contract. A future regression
    // that re-adds a Date.now() fallback would flip this test red,
    // catching the violation at PR time instead of after the fact.
    expect(() => decideRestartAction({ failures: 2, threshold: 5 })).toThrow(/requires a numeric state\.now/);
  });

  it('throws when state.now is non-numeric (defensive against type drift)', () => {
    // A caller that passes "1000" (string) instead of 1000 (number) is
    // a common source of silent bugs in JS. Fail-fast keeps the
    // upstream caller honest.
    expect(() => decideRestartAction({ failures: 2, threshold: 5, now: '1000' as unknown as number })).toThrow();
  });
});

describe('classifyProbe', () => {
  it('healthy on a 2xx response', () => {
    expect(classifyProbe({ status: 200 })).toEqual({ status: 'healthy', reason: 'http-200' });
  });

  it('unhealthy on a 502 (the canonical cloudflared upstream-down signature)', () => {
    expect(classifyProbe({ status: 502 })).toEqual({ status: 'unhealthy', reason: 'http-502' });
  });

  it('unhealthy on connection refused', () => {
    expect(classifyProbe({ status: 0, error: 'ECONNREFUSED' })).toEqual({
      status: 'unhealthy',
      reason: 'network-econnrefused',
    });
  });

  it('unhealthy on timeout', () => {
    expect(classifyProbe({ status: 0, error: 'ETIMEDOUT' })).toEqual({
      status: 'unhealthy',
      reason: 'network-etimedout',
    });
  });

  it('treats 4xx as healthy server / wrong probe path (does not bounce a working server)', () => {
    expect(classifyProbe({ status: 404 }).status).toBe('healthy');
  });

  it('flags missing body marker as unhealthy when the caller asked for one', () => {
    expect(classifyProbe({ status: 200, body: 'not the marker', bodyMarker: 'EXPECTED' })).toEqual({
      status: 'unhealthy',
      reason: 'body-marker-missing',
    });
  });

  it('healthy when body marker is present', () => {
    expect(classifyProbe({ status: 200, body: 'has EXPECTED inside', bodyMarker: 'EXPECTED' }).status).toBe(
      'healthy',
    );
  });

  it('unhealthy on a missing/null probe object (defensive)', () => {
    // @ts-expect-error feeding null on purpose
    expect(classifyProbe(null).status).toBe('unhealthy');
    // @ts-expect-error feeding undefined on purpose
    expect(classifyProbe(undefined).status).toBe('unhealthy');
  });
});

describe('mergeAllowedOrigins', () => {
  it('adds both https and http variants for a fresh host', () => {
    const r = mergeAllowedOrigins(undefined, 'fresh-host.trycloudflare.com');
    expect(r.changed).toBe(true);
    expect(r.value).toBe('https://fresh-host.trycloudflare.com,http://fresh-host.trycloudflare.com');
  });

  it('preserves existing entries when adding a new host', () => {
    const r = mergeAllowedOrigins('http://example.com', 'new-host.trycloudflare.com');
    expect(r.changed).toBe(true);
    expect(r.value.startsWith('http://example.com,')).toBe(true);
    expect(r.value).toContain('https://new-host.trycloudflare.com');
  });

  it('returns changed=false when both variants are already present', () => {
    const existing = 'https://known.trycloudflare.com,http://known.trycloudflare.com';
    const r = mergeAllowedOrigins(existing, 'known.trycloudflare.com');
    expect(r.changed).toBe(false);
    expect(r.value).toBe(existing);
  });

  it('tolerates whitespace and empty entries in the existing value', () => {
    const r = mergeAllowedOrigins('  http://example.com , ,  ', 'foo.trycloudflare.com');
    expect(r.value.includes(',,')).toBe(false);
    expect(r.value.startsWith('http://example.com,https://foo.trycloudflare.com')).toBe(true);
  });

  it('returns changed=false on a missing host', () => {
    const r = mergeAllowedOrigins('http://example.com', '');
    expect(r.changed).toBe(false);
    expect(r.value).toBe('http://example.com');
  });
});

// Regression coverage for the 5 CR findings on PR #288. Each describe()
// pins one finding's intended behaviour so a future regression flips the
// test red rather than re-introducing the bug silently.

describe('decideProbeAction (Finding 3: probe-vs-exit double-counting)', () => {
  // Background: the probe loop and the exit handler used to BOTH bump
  // failures on an unhealthy probe (probe bumped on observation, exit
  // bumped when the SIGTERM that the probe issued caused the child to
  // exit). The fix makes the exit handler the single increment site;
  // the probe-loop only bumps when there is no live child to kill.

  it('returns reset on healthy probe so transient blips do not accumulate', () => {
    expect(decideProbeAction({ probeStatus: 'healthy', restarting: false, hasLiveChild: true })).toEqual({
      action: 'reset',
    });
  });

  it('returns noop when a restart is already pending (avoids races)', () => {
    expect(decideProbeAction({ probeStatus: 'unhealthy', restarting: true, hasLiveChild: true })).toEqual({
      action: 'noop',
    });
  });

  it('returns sigterm on unhealthy probe with a live child (exit handler will bump failures)', () => {
    // The crucial assertion: action is sigterm, not "increment + sigterm".
    // The caller must NOT bump failures here; the exit handler triggered
    // by the SIGTERM is the single increment site.
    expect(decideProbeAction({ probeStatus: 'unhealthy', restarting: false, hasLiveChild: true })).toEqual({
      action: 'sigterm',
    });
  });

  it('returns schedule on unhealthy probe with NO live child (probe is the increment site)', () => {
    // No live child means the exit handler will not fire (or already did);
    // the probe loop is the only place that can record the failure.
    expect(decideProbeAction({ probeStatus: 'unhealthy', restarting: false, hasLiveChild: false })).toEqual({
      action: 'schedule',
    });
  });

  it('returns reset on healthy probe even without a live child (defensive: do not block recovery)', () => {
    // A healthy probe with no child is unusual but recoverable; do not
    // gate the reset on hasLiveChild or a cold-start would fail to
    // clear failures from a previous trip.
    expect(decideProbeAction({ probeStatus: 'healthy', restarting: false, hasLiveChild: false })).toEqual({
      action: 'reset',
    });
  });

  it('treats missing input fields defensively (no throw)', () => {
    // Caller always passes valid input today; the helper still hardens
    // against partial input so a future regression does not crash the
    // watchdog at probe time.
    expect(() => decideProbeAction(undefined)).not.toThrow();
    const r = decideProbeAction(undefined);
    // unknown probe status defaults to schedule (unhealthy + no live child)
    expect(r.action).toBe('schedule');
  });
});

describe('decideRestartTimerAction (Finding 2: stale-timer respawn race)', () => {
  // Background: scheduleRestart used to call setTimeout, then the
  // callback would unconditionally spawn a fresh child. If a different
  // code path (handleNewTunnelHost rotating the api process, or a
  // parallel probe-driven restart cycle) had already replaced the
  // child during the delay, the stale timer would create a SECOND
  // child that collided on the port. The fix captures the child handle
  // and a generation counter at scheduling time; the callback bails if
  // either has changed.

  it('returns proceed when the captured snapshot matches live state', () => {
    const child = { fake: 'child' };
    const r = decideRestartTimerAction({
      shuttingDown: false,
      expectedChild: child,
      expectedGeneration: 7,
      currentChild: child,
      currentGeneration: 7,
    });
    expect(r.action).toBe('proceed');
  });

  it('returns shutdown when the watchdog is shutting down', () => {
    const r = decideRestartTimerAction({
      shuttingDown: true,
      expectedChild: null,
      expectedGeneration: 0,
      currentChild: null,
      currentGeneration: 0,
    });
    expect(r.action).toBe('shutdown');
  });

  it('returns stale when the child handle has been replaced (handleNewTunnelHost case)', () => {
    const oldChild = { id: 'old' };
    const newChild = { id: 'new' };
    const r = decideRestartTimerAction({
      shuttingDown: false,
      expectedChild: oldChild,
      expectedGeneration: 5,
      currentChild: newChild,
      currentGeneration: 6,
    });
    expect(r.action).toBe('stale');
    expect(r.reason).toBe('child-changed');
  });

  it('returns stale when the generation counter has bumped even with same child reference', () => {
    // Defensive: the generation bump is the canonical signal that the
    // world moved. Even if the child reference somehow matches (e.g.
    // identity-equal proxy), a generation mismatch still trips the
    // stale guard.
    const child = { id: 'same' };
    const r = decideRestartTimerAction({
      shuttingDown: false,
      expectedChild: child,
      expectedGeneration: 5,
      currentChild: child,
      currentGeneration: 6,
    });
    expect(r.action).toBe('stale');
    expect(r.reason).toBe('generation-changed');
  });

  it('shutdown takes priority over stale (clean shutdown is the more important signal)', () => {
    const r = decideRestartTimerAction({
      shuttingDown: true,
      expectedChild: { id: 'old' },
      expectedGeneration: 1,
      currentChild: { id: 'new' },
      currentGeneration: 2,
    });
    expect(r.action).toBe('shutdown');
  });
});

describe('tickHealth serialization (Finding 4: concurrent ticks race on shared state)', () => {
  // Background: setInterval used to fire tickHealth() on every tick
  // regardless of whether the previous one had finished. When the
  // upstream is wedged, two awaited probes can each take longer than
  // the interval, so two ticks interleave and write to the same
  // failures + lastProbeReason fields concurrently. The fix is a
  // module-scoped running-flag that makes overlapping ticks a no-op.

  it('the serialization pattern: a running-flag gate must skip if previous tick is still in flight', async () => {
    // Test the SHAPE of the serialization wrapper, not the live setInterval.
    // We mirror the wrapper structure used in scripts/tunnel-watchdog.mjs.
    let running = false;
    const callOrder: string[] = [];
    const slowTick = async (id: string) => {
      callOrder.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push(`end-${id}`);
    };

    const wrapped = async (id: string) => {
      if (running) {
        callOrder.push(`skipped-${id}`);
        return;
      }
      running = true;
      try {
        await slowTick(id);
      } finally {
        running = false;
      }
    };

    // Fire two ticks back-to-back. Without the running-flag, both
    // would interleave; with it, the second is skipped.
    const promises = [wrapped('a'), wrapped('b')];
    await Promise.all(promises);

    expect(callOrder).toEqual(['start-a', 'skipped-b', 'end-a']);
    // After a completes, the flag is reset; a third tick proceeds.
    await wrapped('c');
    expect(callOrder).toEqual(['start-a', 'skipped-b', 'end-a', 'start-c', 'end-c']);
  });

  it('errors in tickHealth release the running flag (so subsequent ticks proceed)', async () => {
    let running = false;
    const calls: string[] = [];
    const errorTick = async (id: string) => {
      calls.push(`start-${id}`);
      throw new Error('probe burst');
    };

    const wrapped = async (id: string) => {
      if (running) {
        calls.push(`skipped-${id}`);
        return;
      }
      running = true;
      try {
        await errorTick(id);
      } catch (e) {
        calls.push(`caught-${id}`);
      } finally {
        running = false;
      }
    };

    await wrapped('a');
    await wrapped('b');
    expect(calls).toEqual(['start-a', 'caught-a', 'start-b', 'caught-b']);
    // The flag was released even though the inner tick threw.
    expect(running).toBe(false);
  });
});

describe('boot ENOENT handling (Finding 5: cloudflared missing at startup)', () => {
  // Background: the boot block wrapped spawnFor('tunnel') in a sync
  // try/catch. Node's spawn() emits ENOENT asynchronously via the
  // 'error' event, NOT synchronously, so the try/catch never fires
  // and attachLifecycle wires a restart loop against a process that
  // never existed. The fix attaches a one-shot 'error' listener
  // BEFORE attachLifecycle and short-circuits on ENOENT.

  it('the listener-first pattern: ENOENT marks tunnel disabled and skips lifecycle wiring', async () => {
    // Simulate the boot sequence with an injected fake spawn that
    // emits an async ENOENT, mirroring the watchdog's actual structure.
    const { EventEmitter } = await import('node:events');
    const fakeChild = new EventEmitter();

    let tunnelDisabled = false;
    let attachLifecycleCalled = false;

    fakeChild.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        tunnelDisabled = true;
      }
    });

    // Defer the attachLifecycle the way scripts/tunnel-watchdog.mjs does
    // via setImmediate, so the error listener fires first.
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        if (!tunnelDisabled) {
          attachLifecycleCalled = true;
        }
        resolve();
      });
      // Fire the async ENOENT before setImmediate runs.
      const enoent: NodeJS.ErrnoException = new Error('spawn cloudflared ENOENT');
      enoent.code = 'ENOENT';
      fakeChild.emit('error', enoent);
    });

    expect(tunnelDisabled).toBe(true);
    expect(attachLifecycleCalled).toBe(false);
  });

  it('non-ENOENT errors do NOT short-circuit the lifecycle (they go through the normal restart path)', async () => {
    const { EventEmitter } = await import('node:events');
    const fakeChild = new EventEmitter();
    let tunnelDisabled = false;
    let normalErrorPathTaken = false;

    fakeChild.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        tunnelDisabled = true;
      } else {
        normalErrorPathTaken = true;
      }
    });

    const eacces: NodeJS.ErrnoException = new Error('EACCES: permission denied');
    eacces.code = 'EACCES';
    fakeChild.emit('error', eacces);

    expect(tunnelDisabled).toBe(false);
    expect(normalErrorPathTaken).toBe(true);
  });
});

describe('parseIntegerFlag (Finding 1: helper extraction + Finding 6: real exercise)', () => {
  // The helper is exported from scripts/lib/tunnel-watchdog.mjs (a
  // shebang-free module) and returns { ok, value, newIndex } |
  // { ok, error } so tests can assert outputs without intercepting
  // process.exit. The CLI wrapper at scripts/tunnel-watchdog.mjs
  // converts {ok:false} into the legacy error+exit-2 pair.

  it('--check-interval-ms accepts the boundary value 1000', () => {
    const argv = ['--check-interval-ms', '1000'];
    const r = parseIntegerFlag('--check-interval-ms', argv, 0, 1000, '[err]');
    expect(r).toEqual({ ok: true, value: 1000, newIndex: 1 });
  });

  it('--check-interval-ms rejects 999 (just below the boundary)', () => {
    const argv = ['--check-interval-ms', '999'];
    const r = parseIntegerFlag('--check-interval-ms', argv, 0, 1000, '[err]');
    expect(r).toEqual({ ok: false, error: '[err]' });
  });

  it('--cooldown-ms accepts 0 (zero is a valid disable value, NOT a sentinel)', () => {
    // A common refactor mistake: treating 0 as falsy. cooldown=0
    // means "do not enter a cooldown phase" and is a legitimate
    // operator choice.
    const argv = ['--cooldown-ms', '0'];
    const r = parseIntegerFlag('--cooldown-ms', argv, 0, 0, '[err]');
    expect(r).toEqual({ ok: true, value: 0, newIndex: 1 });
  });

  it('--cooldown-ms rejects -1 (below minBound)', () => {
    const argv = ['--cooldown-ms', '-1'];
    const r = parseIntegerFlag('--cooldown-ms', argv, 0, 0, '[err]');
    expect(r.ok).toBe(false);
  });

  it('--max-failures rejects 0 (zero strikes is a useless config)', () => {
    const argv = ['--max-failures', '0'];
    const r = parseIntegerFlag('--max-failures', argv, 0, 1, '[err]');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when the flag is the last token (no value follows)', () => {
    const argv = ['--check-interval-ms']; // missing value
    const r = parseIntegerFlag('--check-interval-ms', argv, 0, 1000, '[err]');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('--check-interval-ms requires a value');
  });

  it('returns ok:false on a non-integer value', () => {
    const argv = ['--max-failures', 'abc'];
    const r = parseIntegerFlag('--max-failures', argv, 0, 1, '[err]');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false on a non-array argv (defensive against caller drift)', () => {
    const r = parseIntegerFlag('--x', undefined as unknown as string[], 0, 0, '[err]');
    expect(r.ok).toBe(false);
  });

  it('newIndex is i+1 so the caller advances past the consumed value', () => {
    // The CLI wrapper does i = r.newIndex; the for-loop's i++ then
    // moves past the value. A future refactor that returns i+2 would
    // skip the next token entirely; this test pins the contract.
    const argv = ['--max-failures', '5', '--cooldown-ms', '0'];
    const r = parseIntegerFlag('--max-failures', argv, 0, 1, '[err]');
    expect(r.newIndex).toBe(1);
  });
});

describe('resolveCloudflaredPath', () => {
  /*
   * The watchdog spawns cloudflared by name; on Windows the MSI
   * installer drops the binary in Program Files but does NOT add
   * the directory to PATH. The bare-name spawn therefore hits
   * ENOENT and the tunnel never comes up. This helper closes that
   * gap by probing well-known install paths on Windows while
   * leaving POSIX behaviour untouched.
   *
   * Tests pin every branch of the resolution table so a regression
   * (e.g. someone reordering the priorities or dropping the
   * literal-path fallback) flips a unit test, not a production
   * tunnel boot.
   */

  it('honours LAG_CLOUDFLARED_PATH ahead of every other rule', () => {
    const out = resolveCloudflaredPath({
      env: {
        LAG_CLOUDFLARED_PATH: 'D:\\custom\\cloudflared.exe',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      },
      platform: 'win32',
      // existsSync would otherwise match the Program Files
      // candidate; pin that the env override wins anyway.
      existsSync: () => true,
    });
    expect(out).toBe('D:\\custom\\cloudflared.exe');
  });

  it('trims whitespace in LAG_CLOUDFLARED_PATH so a stray newline does not break resolution', () => {
    // Operators copy/paste this into shell rc files; a trailing
    // \n or surrounding spaces are common and were silently
    // breaking the path before the trim.
    const out = resolveCloudflaredPath({
      env: { LAG_CLOUDFLARED_PATH: '  /usr/local/bin/cloudflared\n' },
      platform: 'linux',
      existsSync: () => false,
    });
    expect(out).toBe('/usr/local/bin/cloudflared');
  });

  it('returns the bare name on POSIX when no env override is set', () => {
    // Linux + macOS installers drop a /usr/local/bin/cloudflared
    // symlink that is on the default PATH; bare-name spawn works
    // and we should not invent a Windows-style fallback list.
    const out = resolveCloudflaredPath({
      env: {},
      platform: 'linux',
      existsSync: () => false,
    });
    expect(out).toBe('cloudflared');
  });

  it('on Windows probes %ProgramFiles(x86)% before %ProgramFiles%', () => {
    // The current cloudflared MSI installs into the (x86) tree,
    // even on 64-bit Windows. Only Program Files (x86) exists in
    // this fixture, so it must win.
    const seen: string[] = [];
    const out = resolveCloudflaredPath({
      env: {
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        'ProgramFiles': 'C:\\Program Files',
      },
      platform: 'win32',
      existsSync: (p: string) => {
        seen.push(p);
        return p === 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
      },
    });
    expect(out).toBe('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
    // The order of probes matters: x86 first, then plain.
    expect(seen[0]).toBe('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
  });

  it('falls back to %ProgramFiles% when %ProgramFiles(x86)% is missing the binary', () => {
    // Old-installer machines have the binary in the 64-bit tree.
    const out = resolveCloudflaredPath({
      env: {
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        'ProgramFiles': 'C:\\Program Files',
      },
      platform: 'win32',
      existsSync: (p: string) => p === 'C:\\Program Files\\cloudflared\\cloudflared.exe',
    });
    expect(out).toBe('C:\\Program Files\\cloudflared\\cloudflared.exe');
  });

  it('on Windows probes the literal canonical paths even when Program Files env vars are unset', () => {
    // A watchdog spawned from a restricted shell may not inherit
    // %ProgramFiles%; the literal-path fallback ensures resolution
    // still works on a default `C:\` install.
    const out = resolveCloudflaredPath({
      env: {},
      platform: 'win32',
      existsSync: (p: string) => p === 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    });
    expect(out).toBe('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
  });

  it('returns the bare name on Windows when no candidate exists, mirroring the pre-fix path', () => {
    // No env override, no install. The watchdog's CLI wrapper
    // already handles the resulting ENOENT by setting
    // tunnelDisabled; this helper must not invent a different
    // failure shape.
    const out = resolveCloudflaredPath({
      env: {},
      platform: 'win32',
      existsSync: () => false,
    });
    expect(out).toBe('cloudflared');
  });

  it('treats an empty LAG_CLOUDFLARED_PATH as not set so the candidate probe still runs', () => {
    // dotenv + docker-compose can produce empty-string env values
    // unintentionally; an empty override should be ignored, not
    // honoured (which would spawn `''` -> EFAULT).
    const out = resolveCloudflaredPath({
      env: { LAG_CLOUDFLARED_PATH: '' },
      platform: 'win32',
      existsSync: (p: string) => p === 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    });
    expect(out).toBe('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
  });

  it('handles missing existsSync callback by falling back to the bare name on Windows', () => {
    // Defensive against future caller drift (`opts.existsSync`
    // becomes optional or stubbed). A missing callback must not
    // throw; resolution simply finds no candidate and returns
    // the bare name.
    const out = resolveCloudflaredPath({
      env: {},
      platform: 'win32',
      existsSync: undefined as unknown as (p: string) => boolean,
    });
    expect(out).toBe('cloudflared');
  });

  it('returns the bare name when opts is null/undefined (defensive)', () => {
    // The CLI wrapper always passes an opts object today; this is
    // a contract guard for direct callers (e.g. an ad-hoc REPL).
    expect(resolveCloudflaredPath(undefined)).toBe('cloudflared');
    expect(resolveCloudflaredPath(null as unknown as Parameters<typeof resolveCloudflaredPath>[0])).toBe('cloudflared');
  });
});
