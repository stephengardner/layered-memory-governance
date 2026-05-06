#!/usr/bin/env node
/**
 * tunnel-watchdog: supervise the LAG Console dev surface plus a
 * cloudflared quick-tunnel, with auto-recovery when the tunnel
 * upstream crashes and auto-allowlist-update when the tunnel hostname
 * rotates.
 *
 * Why this exists
 * ---------------
 * Long /loop runs over a public cloudflared quick-tunnel hit two
 * recurring failure modes:
 *
 *   1. The tunnel returns 502 silently when its upstream (the 9081
 *      backend or the 9080 vite dev server) crashes. cloudflared
 *      itself stays alive; the upstream is gone. With no supervisor,
 *      the operator only notices when they refresh the dashboard
 *      manually -- often hours later.
 *
 *   2. Every cloudflared quick-tunnel restart yields a NEW random
 *      `<adjective>-<noun>-<rand>.trycloudflare.com` hostname. The
 *      9081 server's CORS allowlist (LAG_CONSOLE_ALLOWED_ORIGINS) is
 *      seeded at process start; without an update the new host gets
 *      403'd on every state-changing API call.
 *
 * This script is the OPS-tier supervisor that closes both gaps. It is
 * NOT a substrate primitive (those live under src/); it lives in
 * scripts/ because tunnel-restart logic is operator infrastructure,
 * not a governance contract.
 *
 * What it does
 * ------------
 *   - Spawns three child processes: the 9081 API server, the 9080
 *     vite dev server, and a cloudflared quick-tunnel.
 *   - Health-checks 9080 + 9081 + cloudflared every CHECK_INTERVAL_MS
 *     (default 30s) by issuing a small HTTP probe. Probe outcomes are
 *     classified via the pure helper at scripts/lib/tunnel-watchdog.mjs.
 *   - On an unhealthy classification, restarts the failed component
 *     with an exponential-backoff schedule (also pure helper).
 *   - When cloudflared's stdout reveals a fresh `<host>.trycloudflare.com`
 *     URL, the watchdog merges both `https://<host>` and `http://<host>`
 *     into LAG_CONSOLE_ALLOWED_ORIGINS, kills the API server, and
 *     respawns it with the updated env. Vite re-uses its `.trycloudflare.com`
 *     wildcard host so vite itself does not need a restart.
 *   - Bounded backoff with a circuit-breaker: after N consecutive
 *     failures (default 5) the supervisor enters cooldown rather than
 *     spinning. After the cooldown expires it makes one more attempt.
 *
 * What it does NOT do
 * -------------------
 *   - It does NOT replace `npm run dev`. Operators who want tunnel
 *     resilience launch this; everyone else keeps using `npm run dev`
 *     and learns nothing about the watchdog.
 *   - It does NOT mutate canon, write atoms, or call into the LAG
 *     framework. This is pure ops scaffolding.
 *
 * Usage
 * -----
 *   node scripts/tunnel-watchdog.mjs
 *   node scripts/tunnel-watchdog.mjs --no-tunnel       # supervise only
 *                                                     # the dev servers
 *   node scripts/tunnel-watchdog.mjs --check-interval-ms 60000
 *   node scripts/tunnel-watchdog.mjs --max-failures 8
 *
 * Stop: Ctrl-C (SIGINT). The watchdog forwards the signal to all
 * children and exits cleanly.
 *
 * Exit codes
 * ----------
 *   0  clean shutdown via SIGINT/SIGTERM
 *   1  fatal: a child failed to spawn at all (e.g. cloudflared not
 *      installed) AND the operator did not pass --no-tunnel
 *   2  invalid arguments
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from './lib/tunnel-watchdog.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_DIR = resolve(REPO_ROOT, 'apps', 'console');

// Default knob values. Each is overridable via CLI flag so a deeper
// dogfeed run can dial them without code changes.
const DEFAULTS = {
  apiPort: Number.parseInt(process.env.LAG_CONSOLE_BACKEND_PORT ?? '9081', 10),
  webPort: Number.parseInt(process.env.LAG_CONSOLE_PORT ?? '9080', 10),
  checkIntervalMs: 30_000,
  // Bounded backoff: 1s base, cap at 60s. Five strikes trips the
  // breaker; 5min cooldown then half-open probe. A fundamentally
  // broken upstream therefore consumes at most ~10 restarts/hour at
  // steady state instead of pinning CPU at the watchdog tier.
  baseBackoffMs: 1000,
  maxBackoffMs: 60_000,
  maxFailures: 5,
  cooldownMs: 5 * 60_000,
  spawnTunnel: true,
};

// Adapter that turns the pure parseIntegerFlag (which returns
// { ok, value/error }) into the original inline behaviour: print the
// error to stderr and exit 2 on failure. Keeping the side-effect
// adapter in the CLI wrapper (where process.exit lives) lets the
// pure helper itself stay testable without intercepting exit.
function applyIntegerFlag(name, argv, i, minBound, errorMsg) {
  const r = parseIntegerFlag(name, argv, i, minBound, errorMsg);
  if (!r.ok) {
    console.error(r.error);
    process.exit(2);
  }
  return { value: r.value, newIndex: r.newIndex };
}

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-tunnel') { args.spawnTunnel = false; continue; }
    if (a === '--check-interval-ms' && i + 1 < argv.length) {
      const r = applyIntegerFlag(a, argv, i, 1000, '[tunnel-watchdog] --check-interval-ms must be >= 1000');
      args.checkIntervalMs = r.value;
      i = r.newIndex;
      continue;
    }
    if (a === '--max-failures' && i + 1 < argv.length) {
      const r = applyIntegerFlag(a, argv, i, 1, '[tunnel-watchdog] --max-failures must be >= 1');
      args.maxFailures = r.value;
      i = r.newIndex;
      continue;
    }
    if (a === '--cooldown-ms' && i + 1 < argv.length) {
      const r = applyIntegerFlag(a, argv, i, 0, '[tunnel-watchdog] --cooldown-ms must be >= 0');
      args.cooldownMs = r.value;
      i = r.newIndex;
      continue;
    }
    if (a === '--help' || a === '-h') {
      console.log('Usage: see header docstring in scripts/tunnel-watchdog.mjs');
      process.exit(0);
    }
    console.error(`[tunnel-watchdog] unknown argument: ${a}`);
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[tunnel-watchdog ${ts}] ${msg}`);
}

function errLog(msg) {
  const ts = new Date().toISOString();
  console.error(`[tunnel-watchdog ${ts}] ${msg}`);
}

// Per-component supervised state. Each component tracks its child
// process handle, consecutive failure count, last trip time, last
// probe result, and a "currently restarting" flag so we never spawn
// two replacement processes for the same target.
function makeComponentState(name) {
  return {
    name,
    child: null,
    failures: 0,
    lastTripAt: null,
    lastProbeReason: 'init',
    restarting: false,
    // Monotonic counter incremented every time state.child is replaced.
    // Stale setTimeout callbacks (e.g. a queued restart whose target
    // child was already replaced by an unrelated respawn path like
    // handleNewTunnelHost) compare against this to detect that the
    // world moved out from under them and skip the respawn.
    generation: 0,
  };
}

const components = {
  api: makeComponentState('api'),
  web: makeComponentState('web'),
  tunnel: makeComponentState('tunnel'),
};

// The current allowlist value. Seeded from the operator's env (so
// pre-existing entries are preserved); cloudflared host discoveries
// merge in below.
let currentAllowedOrigins = process.env.LAG_CONSOLE_ALLOWED_ORIGINS ?? '';

// Spawn helpers. Each returns the ChildProcess; the caller registers
// the exit handler that schedules a restart.

function spawnApi() {
  const env = {
    ...process.env,
    LAG_CONSOLE_ALLOWED_ORIGINS: currentAllowedOrigins,
    LAG_CONSOLE_BACKEND_PORT: String(args.apiPort),
  };
  const child = spawn('npm', ['run', 'dev:server'], {
    cwd: CONSOLE_DIR,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32', // npm.cmd on Windows
  });
  return child;
}

function spawnWeb() {
  const env = {
    ...process.env,
    LAG_CONSOLE_PORT: String(args.webPort),
    LAG_CONSOLE_BACKEND_PORT: String(args.apiPort),
  };
  const child = spawn('npm', ['run', 'dev:web'], {
    cwd: CONSOLE_DIR,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  return child;
}

function spawnTunnel() {
  // cloudflared on Windows is installed under
  // `%ProgramFiles(x86)%\cloudflared\cloudflared.exe` (current
  // installer) or `%ProgramFiles%\cloudflared\cloudflared.exe`
  // (older installer). Neither directory is added to PATH by the
  // cloudflared MSI, so a fresh-install operator hits ENOENT when
  // we spawn the bare name. resolveCloudflaredPath probes both
  // locations + an env override (`LAG_CLOUDFLARED_PATH`) before
  // falling back to the bare name, which keeps POSIX behaviour
  // unchanged and lets Windows pick up the binary without a PATH
  // edit. If nothing matches, spawn() emits the same ENOENT it did
  // before the helper, so the `tunnelDisabled` branch below still
  // catches the missing-binary case.
  const cloudflaredCmd = resolveCloudflaredPath({
    env: process.env,
    platform: process.platform,
    existsSync,
  });
  const child = spawn(cloudflaredCmd, [
    'tunnel',
    '--url',
    `http://localhost:${args.webPort}`,
    '--no-autoupdate',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // cloudflared logs the assigned URL once at startup. Watch both
  // streams; older versions log to stderr, newer to stdout.
  const handleChunk = (chunk) => {
    const text = chunk.toString('utf8');
    process.stdout.write(text);
    const host = parseTrycloudflareHostname(text);
    if (host) handleNewTunnelHost(host);
  };
  child.stdout?.on('data', handleChunk);
  child.stderr?.on('data', handleChunk);
  return child;
}

function spawnFor(name) {
  if (name === 'api') return spawnApi();
  if (name === 'web') return spawnWeb();
  if (name === 'tunnel') return spawnTunnel();
  throw new Error(`unknown component: ${name}`);
}

// Wire a component's spawn + exit handling. On exit, schedule a
// restart per the breaker policy.
function attachLifecycle(state, opts = {}) {
  const child = state.child;
  if (!child) return;
  child.on('error', (err) => {
    errLog(`${state.name}: spawn error: ${err?.message ?? err}`);
    state.failures += 1;
    scheduleRestart(state.name);
  });
  child.on('exit', (code, signal) => {
    if (opts.intentionalExit) return; // suppressed below during respawn-on-host-change
    log(`${state.name}: exited (code=${code} signal=${signal})`);
    state.failures += 1;
    scheduleRestart(state.name);
  });
}

let shuttingDown = false;

function scheduleRestart(name) {
  if (shuttingDown) return;
  const state = components[name];
  if (!state) return;
  if (state.restarting) return; // a restart is already pending
  const action = decideRestartAction({
    failures: state.failures,
    threshold: args.maxFailures,
    cooldownMs: args.cooldownMs,
    lastTripAt: state.lastTripAt,
    now: Date.now(),
  });
  if (action.verdict === 'tripped') {
    errLog(`${state.name}: circuit breaker open (failures=${state.failures}, no cooldown configured); halting restarts for this component`);
    return;
  }
  if (action.verdict === 'cooldown') {
    if (state.lastTripAt === null) state.lastTripAt = Date.now();
    log(`${state.name}: cooldown (${action.reason}); will re-evaluate on next tick`);
    return;
  }
  // 'attempt'
  if (action.reason === 'cooldown-elapsed') {
    log(`${state.name}: cooldown elapsed, half-open probe`);
    state.failures = Math.max(0, args.maxFailures - 1);
    state.lastTripAt = null;
  }
  const delay = nextBackoffMs({
    failures: state.failures,
    baseMs: args.baseBackoffMs,
    maxMs: args.maxBackoffMs,
  });
  log(`${state.name}: scheduling restart in ${delay}ms (failures=${state.failures})`);
  state.restarting = true;
  // Capture the child handle and a generation counter at scheduling
  // time. If a different code path replaces state.child (e.g. the
  // handleNewTunnelHost rotation respawns api with new env, or a
  // parallel probe-driven SIGTERM has already triggered a fresh exit
  // -> scheduleRestart cycle that beat us to it), the stale timer must
  // bail out instead of producing a second respawn that collides on
  // the port. The decision logic is in lib/tunnel-watchdog.mjs so it
  // can be unit-tested without standing up real child processes.
  const expectedChild = state.child;
  const expectedGeneration = state.generation;
  setTimeout(() => {
    state.restarting = false;
    const decision = decideRestartTimerAction({
      shuttingDown,
      expectedChild,
      expectedGeneration,
      currentChild: state.child,
      currentGeneration: state.generation,
    });
    if (decision.action === 'shutdown') return;
    if (decision.action === 'stale') {
      log(`${state.name}: stale restart timer skipped (${decision.reason})`);
      return;
    }
    try {
      state.child = spawnFor(state.name);
      state.generation += 1;
      attachLifecycle(state);
      log(`${state.name}: respawned`);
    } catch (err) {
      errLog(`${state.name}: respawn failed: ${err?.message ?? err}`);
      state.failures += 1;
      scheduleRestart(state.name);
    }
  }, delay);
}

// When cloudflared advertises a new tunnel hostname, merge it into
// LAG_CONSOLE_ALLOWED_ORIGINS and bounce the API server so the new
// origin gets through CORS. Vite uses an `.trycloudflare.com`
// wildcard host so it does not need a restart.
function handleNewTunnelHost(host) {
  const merged = mergeAllowedOrigins(currentAllowedOrigins, host);
  if (!merged.changed) return;
  log(`tunnel: new host ${host}; updating LAG_CONSOLE_ALLOWED_ORIGINS and bouncing api server`);
  currentAllowedOrigins = merged.value;
  const api = components.api;
  // Toggle the same restarting flag scheduleRestart uses so a
  // concurrent probe-loop tick or scheduleRestart call sees an
  // in-flight rotation and short-circuits, avoiding a duplicate
  // respawn on top of this one. Cleared inside the once('exit')
  // callback once the replacement child is live; cleared in the
  // catch path so a respawn failure does not leave the flag stuck.
  api.restarting = true;
  if (api.child && !api.child.killed) {
    api.child.removeAllListeners('exit');
    api.child.once('exit', () => {
      try {
        api.child = spawnFor('api');
        api.generation += 1;
        attachLifecycle(api);
        log('api: respawned with updated LAG_CONSOLE_ALLOWED_ORIGINS');
      } finally {
        api.restarting = false;
      }
    });
    api.child.kill('SIGTERM');
  } else {
    // No live api child: spawn fresh (the periodic probe loop will
    // have already noticed and scheduled a restart, so we may be
    // racing it; the generation bump invalidates any in-flight stale
    // restart timer in scheduleRestart).
    try {
      api.child = spawnFor('api');
      api.generation += 1;
      attachLifecycle(api);
    } finally {
      api.restarting = false;
    }
  }
}

// Periodic health probes. Each tick, classify each component's probe
// outcome and increment failures on unhealthy. The actual restart is
// driven by exit events in steady state; the probe-driven restart is
// the recovery path for the "process alive but wedged" case (the
// canonical 502 silent-cloudflared scenario).
async function probe(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    let body = '';
    if (opts.bodyMarker) {
      try { body = (await res.text()).slice(0, 4096); } catch {}
    }
    return { status: res.status, body, bodyMarker: opts.bodyMarker };
  } catch (err) {
    let code = 'EOTHER';
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') code = 'ETIMEDOUT';
    else if (typeof err?.cause?.code === 'string') code = err.cause.code;
    else if (typeof err?.code === 'string') code = err.code;
    return { status: 0, error: code };
  } finally {
    clearTimeout(timer);
  }
}

// Apply the pure probe-decision to a component's live state. Wires
// the side effects (failures bump, SIGTERM, scheduleRestart) so the
// decision in decideProbeAction stays pure.
function applyProbeAction(name, result) {
  const state = components[name];
  if (!state) return;
  const hasLiveChild = !!(state.child && !state.child.killed);
  const decision = decideProbeAction({
    probeStatus: result.status,
    restarting: state.restarting,
    hasLiveChild,
  });
  if (decision.action === 'reset') {
    state.failures = 0;
    return;
  }
  if (decision.action === 'noop') return;
  if (decision.action === 'sigterm') {
    log(`${name}: probe unhealthy (${result.reason}); SIGTERM to flush through exit handler`);
    try { state.child.kill('SIGTERM'); } catch {}
    return;
  }
  // 'schedule'
  log(`${name}: probe unhealthy (${result.reason}); no live child, scheduling restart`);
  state.failures += 1;
  scheduleRestart(name);
}

async function tickHealth() {
  if (shuttingDown) return;
  const apiUrl = `http://localhost:${args.apiPort}/api/health`;
  const webUrl = `http://localhost:${args.webPort}/`;
  const apiResult = classifyProbe(await probe(apiUrl));
  const webResult = classifyProbe(await probe(webUrl));
  components.api.lastProbeReason = apiResult.reason;
  components.web.lastProbeReason = webResult.reason;
  // Healthy probes reset the failures counter so transient blips do
  // not accumulate toward the breaker. The exit handler is the
  // SINGLE place that increments failures after an actual child exit;
  // the probe branch only increments when there is no live child to
  // kill (otherwise the SIGTERM below produces an exit event that
  // hits the increment site, causing double-counting). Decision logic
  // is in lib/tunnel-watchdog.mjs (decideProbeAction) so it is unit
  // tested without spinning real children.
  applyProbeAction('api', apiResult);
  applyProbeAction('web', webResult);
  // Tunnel probe is implicit: cloudflared exiting is observed by the
  // 'exit' handler. We do not synthesize a tunnel-health probe here
  // because the canonical signature (502 from a public URL) requires
  // hitting the public hostname, which the watchdog only learns when
  // cloudflared logs it.
}

// Wire shutdown handling. Forward SIGINT/SIGTERM to children and
// suppress restart scheduling so we don't fight ourselves on the way
// out.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown: forwarding ${signal} to children`);
  for (const name of Object.keys(components)) {
    const c = components[name];
    if (c.child && !c.child.killed) {
      try { c.child.kill(signal); } catch {}
    }
  }
  // Give children up to 5s to exit cleanly, then exit ourselves.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Boot.
log(`booting watchdog (api=${args.apiPort}, web=${args.webPort}, tunnel=${args.spawnTunnel})`);
components.api.child = spawnFor('api');
components.api.generation += 1;
attachLifecycle(components.api);
components.web.child = spawnFor('web');
components.web.generation += 1;
attachLifecycle(components.web);
if (args.spawnTunnel) {
  try {
    const tunnelChild = spawnFor('tunnel');
    // ENOENT (cloudflared not installed) is emitted asynchronously as
    // a 'spawn'-time error event, so a sync try/catch around spawnFor
    // never catches it. Attach a one-shot listener BEFORE wiring the
    // restart loop so a missing-binary signal short-circuits cleanly
    // rather than spinning attachLifecycle's restart logic against a
    // process that never existed.
    let tunnelDisabled = false;
    tunnelChild.once('error', (err) => {
      if (err?.code === 'ENOENT') {
        errLog('tunnel: cloudflared not found. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), set LAG_CLOUDFLARED_PATH to its absolute path, or pass --no-tunnel to silence this');
        tunnelDisabled = true;
        components.tunnel.child = null;
      } else {
        errLog(`tunnel: spawn error: ${err?.message ?? err}`);
        components.tunnel.failures += 1;
        scheduleRestart('tunnel');
      }
    });
    components.tunnel.child = tunnelChild;
    components.tunnel.generation += 1;
    // Defer attachLifecycle to next tick so the ENOENT listener above
    // fires first if the binary is missing; otherwise wire normal
    // lifecycle handling. setImmediate keeps the boot sequence
    // synchronous-looking while letting libuv flush the spawn error.
    setImmediate(() => {
      if (tunnelDisabled || shuttingDown) return;
      attachLifecycle(components.tunnel);
    });
  } catch (err) {
    errLog(`tunnel: spawn failed: ${err?.message ?? err}`);
    errLog('tunnel: continuing without a tunnel; pass --no-tunnel to silence this');
  }
}

// Health probe loop. setInterval is idiomatic for "do this every N
// ms"; the unref() is so the watchdog exits when nothing else is
// pinning the loop (e.g. all children gone after shutdown).
//
// Serialize: tickHealth() awaits two HTTP probes back-to-back, which
// can take longer than the interval itself when the upstream is
// wedged. Without serialization, two ticks would interleave and race
// on shared state (lastProbeReason, failures). The running-flag gate
// makes overlapping ticks a no-op rather than a corruption source.
let tickHealthRunning = false;
setInterval(async () => {
  if (tickHealthRunning) return;
  tickHealthRunning = true;
  try {
    await tickHealth();
  } catch (err) {
    errLog(`probe tick error: ${err?.message ?? err}`);
  } finally {
    tickHealthRunning = false;
  }
}, args.checkIntervalMs).unref();
