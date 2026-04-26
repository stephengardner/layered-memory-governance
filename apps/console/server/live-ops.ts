/**
 * Pure helpers for the /api/live-ops.snapshot handler. Aggregates a
 * "what is the org doing right now" digest over the AtomStore so the
 * Live Ops dashboard can render every section from a single round-trip
 * (TanStack Query refetchInterval=2s would otherwise hit seven
 * endpoints).
 *
 * Design constraints baked into this module:
 *   - Pure functions, no I/O. The handler in server/index.ts feeds
 *     this module the full atom array via readAllAtoms() so the
 *     functions remain unit-testable without a live atom store.
 *   - Read-only by construction. Every helper computes; none writes.
 *     v1 read-only contract is preserved per apps/console/CLAUDE.md.
 *   - Bounded payload. Each list caps at MAX_LIST_ITEMS so a runaway
 *     atom store can never blow the response size or the client
 *     render budget. Document the cap so consumers know they're
 *     looking at the head of the feed, not the universe.
 *   - UTC ISO timestamps assumed. Atoms carry created_at as UTC ISO
 *     per the AtomStore contract; clock skew between system time and
 *     atom timestamps is the only error source for time-window math
 *     and stays within tolerable bounds for a 2s refresh dashboard.
 *
 * The module is wired into server/index.ts; see the
 * /api/live-ops.snapshot route there for the request handler.
 */
import type { LiveOpsAtom, LiveOpsSnapshot } from './live-ops-types';

/**
 * Hard cap on every list field returned by the snapshot. Bounds the
 * payload so a freshly-watered atom store with thousands of plans
 * never lands a multi-megabyte JSON in the operator's browser tab.
 * The dashboard surfaces "head of the feed"; deeper inspection is
 * the per-feature views (Plans, Activities, Plan Lifecycle).
 */
export const MAX_LIST_ITEMS = 20;

/*
 * Time windows for the heartbeat tile. Expressed in milliseconds so
 * comparisons against atom.created_at parsed via Date.parse stay in
 * the same unit. Keep these as named constants (not magic numbers)
 * so the wire shape under heartbeat documents itself.
 */
const ONE_MINUTE_MS = 60 * 1000;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const FIFTEEN_MINUTES_MS = 15 * ONE_MINUTE_MS;
const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
/** A session is "active" if its latest agent-turn lands inside this window. */
const ACTIVE_SESSION_TURN_WINDOW_MS = 5 * 60 * 1000;

/**
 * Parse an ISO timestamp (UTC) into a numeric epoch ms. Returns NaN
 * for nullish/malformed input -- callers must check Number.isFinite
 * before using the result. We deliberately do not throw; bad
 * timestamps are atom-quality bugs the dashboard should ignore, not
 * propagate as a 500 to the operator.
 */
export function parseIsoTs(value: string | undefined | null): number {
  if (typeof value !== 'string' || value.length === 0) return NaN;
  return Date.parse(value);
}

/**
 * Count atoms whose created_at falls inside [now - windowMs, now].
 * Pure; takes `now` as a parameter so tests can pin a deterministic
 * clock without mocking globals.
 */
export function countAtomsSince(
  atoms: ReadonlyArray<LiveOpsAtom>,
  now: number,
  windowMs: number,
): number {
  const start = now - windowMs;
  let count = 0;
  for (const atom of atoms) {
    const ts = parseIsoTs(atom.created_at);
    if (Number.isFinite(ts) && ts >= start && ts <= now) count += 1;
  }
  return count;
}

/**
 * Heartbeat: atom write rate over rolling windows.
 *   - last_60s, last_5m, last_1h: raw counts
 *   - delta: last_60s minus the prior 60s (one-window-back), so a
 *     positive number means the org is accelerating. Clamped at zero
 *     when there's no prior window (e.g., empty store) so the UI
 *     arrow never points "down" against a baseline of nothing.
 *
 * "Per minute" rates are intentionally NOT pre-computed here; the UI
 * formatter handles the human label. We surface raw counts so a
 * test or alternate consumer can compute its own view.
 */
export function computeHeartbeat(
  atoms: ReadonlyArray<LiveOpsAtom>,
  now: number,
): LiveOpsSnapshot['heartbeat'] {
  const last60s = countAtomsSince(atoms, now, ONE_MINUTE_MS);
  const last5m = countAtomsSince(atoms, now, FIVE_MINUTES_MS);
  const last1h = countAtomsSince(atoms, now, ONE_HOUR_MS);
  // Prior 60s = atoms in [now - 120s, now - 60s).
  const priorWindowStart = now - 2 * ONE_MINUTE_MS;
  const priorWindowEnd = now - ONE_MINUTE_MS;
  let priorCount = 0;
  for (const atom of atoms) {
    const ts = parseIsoTs(atom.created_at);
    if (Number.isFinite(ts) && ts >= priorWindowStart && ts < priorWindowEnd) {
      priorCount += 1;
    }
  }
  return {
    last_60s: last60s,
    last_5m: last5m,
    last_1h: last1h,
    delta: last60s - priorCount,
  };
}

/**
 * Active sessions: agent-session atoms either lacking a metadata.ended_at
 * OR whose latest agent-turn timestamp is within ACTIVE_SESSION_TURN_WINDOW_MS.
 *
 * The substrate (PR #166 onwards) writes agent-session atoms when a
 * sub-agent loop opens and agent-turn atoms before each LLM call. A
 * session is "live" if the substrate has not closed it AND we have
 * recent evidence of activity. Sessions with no turns (just-spawned)
 * count as active until their first turn lands or they explicitly
 * end -- otherwise the dashboard wouldn't show the session that was
 * opened 200ms before the snapshot fired.
 */
export function listActiveSessions(
  atoms: ReadonlyArray<LiveOpsAtom>,
  now: number,
): LiveOpsSnapshot['active_sessions'] {
  // Index latest agent-turn per session_id for O(1) lookup.
  const latestTurnBySession = new Map<string, number>();
  for (const atom of atoms) {
    if (atom.type !== 'agent-turn') continue;
    if (atom.taint && atom.taint !== 'clean') continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const sid = typeof meta['session_id'] === 'string' ? (meta['session_id'] as string) : null;
    if (!sid) continue;
    const ts = parseIsoTs(atom.created_at);
    if (!Number.isFinite(ts)) continue;
    const prev = latestTurnBySession.get(sid);
    if (prev === undefined || ts > prev) latestTurnBySession.set(sid, ts);
  }

  const out: Array<{
    session_id: string;
    principal_id: string;
    started_at: string;
    last_turn_at: string | null;
  }> = [];
  for (const atom of atoms) {
    if (atom.type !== 'agent-session') continue;
    if (atom.taint && atom.taint !== 'clean') continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const endedAt = typeof meta['ended_at'] === 'string' ? (meta['ended_at'] as string) : null;
    const sessionId = typeof meta['session_id'] === 'string' ? (meta['session_id'] as string) : atom.id;
    const startedAt = typeof meta['started_at'] === 'string'
      ? (meta['started_at'] as string)
      : atom.created_at;
    const lastTurnTs = latestTurnBySession.get(sessionId) ?? null;
    const lastTurnAt = lastTurnTs !== null ? new Date(lastTurnTs).toISOString() : null;
    // Active iff (a) no ended_at AND (b) either we have a recent turn
    // or we have no turns at all (just-spawned).
    const turnRecent = lastTurnTs === null || (now - lastTurnTs) <= ACTIVE_SESSION_TURN_WINDOW_MS;
    const isActive = endedAt === null && turnRecent;
    if (!isActive) continue;
    out.push({
      session_id: sessionId,
      principal_id: atom.principal_id,
      started_at: startedAt,
      last_turn_at: lastTurnAt,
    });
  }
  // Most-recent-turn first (or started_at if no turns yet).
  out.sort((a, b) => {
    const aT = a.last_turn_at ?? a.started_at;
    const bT = b.last_turn_at ?? b.started_at;
    return bT.localeCompare(aT);
  });
  return out.slice(0, MAX_LIST_ITEMS);
}

/**
 * Live deliberations: plan atoms in plan_state='proposed' ordered by
 * recency. Each row carries plan id, title (extracted from metadata
 * or first line of content), signing principal, and age in seconds
 * computed against `now`.
 *
 * Title resolution priority:
 *   1. metadata.title (planning-actor writes this explicitly)
 *   2. first non-empty line of content stripped of leading "# "
 *   3. atom.id (last-resort fallback so the row is never empty)
 */
export function listLiveDeliberations(
  atoms: ReadonlyArray<LiveOpsAtom>,
  now: number,
): LiveOpsSnapshot['live_deliberations'] {
  const proposed: Array<{ atom: LiveOpsAtom; ts: number }> = [];
  for (const atom of atoms) {
    const planState = atomPlanState(atom);
    if (planState !== 'proposed') continue;
    if (atom.superseded_by && atom.superseded_by.length > 0) continue;
    if (atom.taint && atom.taint !== 'clean') continue;
    const ts = parseIsoTs(atom.created_at);
    if (!Number.isFinite(ts)) continue;
    proposed.push({ atom, ts });
  }
  proposed.sort((a, b) => b.ts - a.ts);
  return proposed.slice(0, MAX_LIST_ITEMS).map(({ atom, ts }) => ({
    plan_id: atom.id,
    title: extractPlanTitle(atom),
    principal_id: atom.principal_id,
    age_seconds: Math.max(0, Math.round((now - ts) / 1000)),
  }));
}

/**
 * In-flight executions: plan atoms in plan_state='executing'. Each
 * row reports plan id, dispatch timestamp, age since dispatch, and
 * the principal that performed the dispatch.
 *
 * Dispatch timestamp resolution priority (since metadata.approved_at
 * marks "we said go" and metadata.dispatch_result.at marks "the
 * executor actually started"):
 *   1. metadata.dispatch_result.at  (executor side; truer "started")
 *   2. metadata.approved_at         (approval side; close enough)
 *   3. atom.created_at              (last-resort; plan write time)
 */
export function listInFlightExecutions(
  atoms: ReadonlyArray<LiveOpsAtom>,
  now: number,
): LiveOpsSnapshot['in_flight_executions'] {
  const executing: Array<{ atom: LiveOpsAtom; dispatchTs: number; dispatchedAt: string }> = [];
  for (const atom of atoms) {
    const planState = atomPlanState(atom);
    if (planState !== 'executing') continue;
    if (atom.superseded_by && atom.superseded_by.length > 0) continue;
    if (atom.taint && atom.taint !== 'clean') continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const dispatch = (meta['dispatch_result'] as Record<string, unknown> | undefined) ?? null;
    const dispatchAt = typeof dispatch?.['at'] === 'string'
      ? (dispatch['at'] as string)
      : typeof meta['approved_at'] === 'string'
        ? (meta['approved_at'] as string)
        : atom.created_at;
    const dispatchTs = parseIsoTs(dispatchAt);
    if (!Number.isFinite(dispatchTs)) continue;
    executing.push({ atom, dispatchTs, dispatchedAt: dispatchAt });
  }
  executing.sort((a, b) => b.dispatchTs - a.dispatchTs);
  return executing.slice(0, MAX_LIST_ITEMS).map(({ atom, dispatchTs, dispatchedAt }) => {
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const dispatchedBy = typeof meta['approved_by'] === 'string'
      ? (meta['approved_by'] as string)
      : atom.principal_id;
    return {
      plan_id: atom.id,
      dispatched_at: dispatchedAt,
      age_seconds: Math.max(0, Math.round((now - dispatchTs) / 1000)),
      dispatched_by: dispatchedBy,
    };
  });
}

/**
 * Recent transitions: plan-merge-settled atoms inside the last 15
 * minutes. Each settled atom records a previous and target plan
 * state on its metadata, providing the prev -> new pair the operator
 * sees in the timeline.
 *
 * Why settled atoms (not raw plan_state diffs): the AtomStore does
 * not version individual fields on a plan, so the only durable
 * record of a transition is a downstream observation atom written
 * AT the transition. plan-merge-settled is the canonical signal for
 * executing -> succeeded; for v1 we surface that one transition.
 * Other transitions (proposed -> approved, executing -> failed)
 * appear in the in_flight_executions and live_deliberations lists
 * by virtue of their resulting state; the dedicated transitions
 * list focuses on the closing edge.
 */
export function listRecentTransitions(
  atoms: ReadonlyArray<LiveOpsAtom>,
  now: number,
): LiveOpsSnapshot['recent_transitions'] {
  const start = now - FIFTEEN_MINUTES_MS;
  const transitions: Array<{
    plan_id: string;
    prev_state: string;
    new_state: string;
    at: string;
    ts: number;
    principal_id: string;
  }> = [];
  for (const atom of atoms) {
    if (atom.type !== 'plan-merge-settled') continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const planId = typeof meta['plan_id'] === 'string' ? (meta['plan_id'] as string) : null;
    const target = typeof meta['target_plan_state'] === 'string'
      ? (meta['target_plan_state'] as string)
      : null;
    const at = typeof meta['settled_at'] === 'string'
      ? (meta['settled_at'] as string)
      : atom.created_at;
    if (!planId || !target) continue;
    const ts = parseIsoTs(at);
    if (!Number.isFinite(ts) || ts < start) continue;
    transitions.push({
      plan_id: planId,
      // The settled atom carries target state but not prior state
      // explicitly; the only state that transitions to a settled-bound
      // target is `executing`, so we can label the source confidently
      // for v1. If a transition outside that flow ever needs the row,
      // the projection should change shape; right now this single
      // assumption keeps the wire compact.
      prev_state: 'executing',
      new_state: target,
      at,
      ts,
      principal_id: atom.principal_id,
    });
  }
  transitions.sort((a, b) => b.ts - a.ts);
  return transitions.slice(0, MAX_LIST_ITEMS).map(({ ts: _ts, ...rest }) => rest);
}

/**
 * Daemon + autonomy posture. Aggregates kill-switch sentinel state,
 * configured autonomy tier, and any L3 elevation atoms whose
 * expires_at is in the future and whose metadata.elevation block is
 * present.
 *
 * `kill_switch_engaged` reflects whether the soft tier (or above)
 * is currently active. Boolean for the UI; the deeper detail (which
 * tier, since when, why) lives in the existing /api/kill-switch.state
 * endpoint that the Control Panel view consumes. Live Ops shows the
 * binary signal at a glance.
 *
 * Active elevations are L3 directive atoms (typically pol-* or
 * dev-*) whose metadata.elevation.expires_at is in the future. Each
 * row exposes id, started_at, expires_at, ms_until_expiry -- the UI
 * formats the countdown.
 */
export function computeDaemonPosture(
  atoms: ReadonlyArray<LiveOpsAtom>,
  now: number,
  killSwitchTier: 'off' | 'soft' | 'medium' | 'hard',
  autonomyDial: number,
): LiveOpsSnapshot['daemon_posture'] {
  const elevations: Array<{
    atom_id: string;
    started_at: string | null;
    expires_at: string;
    ms_until_expiry: number;
  }> = [];
  for (const atom of atoms) {
    if (atom.layer !== 'L3') continue;
    if (atom.taint && atom.taint !== 'clean') continue;
    if (atom.superseded_by && atom.superseded_by.length > 0) continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    const elevation = meta['elevation'] as Record<string, unknown> | undefined;
    if (!elevation) continue;
    const startedAt = typeof elevation['started_at'] === 'string'
      ? (elevation['started_at'] as string)
      : null;
    const expiresAt = typeof elevation['expires_at'] === 'string'
      ? (elevation['expires_at'] as string)
      : null;
    if (!expiresAt) continue;
    const expiresTs = parseIsoTs(expiresAt);
    if (!Number.isFinite(expiresTs) || expiresTs <= now) continue;
    elevations.push({
      atom_id: atom.id,
      started_at: startedAt,
      expires_at: expiresAt,
      ms_until_expiry: Math.max(0, expiresTs - now),
    });
  }
  // Soonest-to-expire first so the operator sees imminent elevations.
  elevations.sort((a, b) => a.ms_until_expiry - b.ms_until_expiry);
  return {
    kill_switch_engaged: killSwitchTier !== 'off',
    kill_switch_tier: killSwitchTier,
    autonomy_dial: autonomyDial,
    active_elevations: elevations.slice(0, MAX_LIST_ITEMS),
  };
}

/**
 * PR activity: recent pr-observation and plan-merge-settled atoms in
 * the last 24h. Each row carries pr_number (when extractable),
 * title (best-effort from the pr-observation metadata), state
 * (open|merged|closed), and the at timestamp.
 *
 * v1 best-effort: pr-observation atoms carry rich payload shape
 * differences across producers (pr-landing-agent vs code-author);
 * we extract conservatively. Missing fields render as null on the
 * UI side; the section never crashes on shape variance.
 */
export function listPrActivity(
  atoms: ReadonlyArray<LiveOpsAtom>,
  now: number,
): LiveOpsSnapshot['pr_activity'] {
  const start = now - TWENTY_FOUR_HOURS_MS;
  // Map pr_number -> latest observation. Multiple pr-observation
  // atoms per PR (one per HEAD update) are noisy; the latest carries
  // the freshest state. The plan-merge-settled atom adds a "merged"
  // outcome marker that overrides the observation state when present.
  const byPr = new Map<number, {
    pr_number: number;
    title: string | null;
    state: string;
    at: string;
    ts: number;
    merged: boolean;
  }>();
  for (const atom of atoms) {
    if (atom.type !== 'observation' && atom.type !== 'plan-merge-settled') continue;
    const meta = (atom.metadata ?? {}) as Record<string, unknown>;
    if (atom.type === 'observation') {
      const kind = typeof meta['kind'] === 'string' ? (meta['kind'] as string) : '';
      if (kind !== 'pr-observation') continue;
    }
    const ts = parseIsoTs(atom.created_at);
    if (!Number.isFinite(ts) || ts < start) continue;
    // pr_number lives at metadata.pr_number for pr-observation, or at
    // metadata.pr.number for plan-merge-settled; check both.
    const rawNumDirect = meta['pr_number'];
    const prSubObj = meta['pr'] as Record<string, unknown> | undefined;
    const rawNumNested = prSubObj?.['number'];
    const prNumber = typeof rawNumDirect === 'number'
      ? rawNumDirect
      : typeof rawNumNested === 'number'
        ? rawNumNested
        : null;
    if (prNumber === null) continue;
    const stateRaw = typeof meta['pr_state'] === 'string' ? (meta['pr_state'] as string) : null;
    const state = atom.type === 'plan-merge-settled'
      ? 'merged'
      : (stateRaw ? stateRaw.toLowerCase() : 'unknown');
    const title = typeof meta['pr_title'] === 'string' ? (meta['pr_title'] as string) : null;
    const isSettled = atom.type === 'plan-merge-settled';
    const existing = byPr.get(prNumber);
    // Sticky-merged invariant: once `plan-merge-settled` is observed
    // for a PR, the row state stays 'merged' regardless of any later
    // pr-observation. Without this, a stale OPEN observation arriving
    // after the settled atom (or any GitHub re-open from a revert
    // flow that lands as pr_state=OPEN) silently rewinds the tile
    // from 'merged' back to 'open'. The aggregator owns this rule;
    // the UI does not need to know about settled-vs-observation.
    if (!existing) {
      byPr.set(prNumber, {
        pr_number: prNumber,
        title,
        state,
        at: atom.created_at,
        ts,
        merged: isSettled,
      });
    } else if (ts > existing.ts) {
      const nextMerged = existing.merged || isSettled;
      byPr.set(prNumber, {
        pr_number: prNumber,
        title: title ?? existing.title,
        state: nextMerged ? 'merged' : state,
        at: atom.created_at,
        ts,
        merged: nextMerged,
      });
    } else if (isSettled) {
      // Settled atom is older than the current pick but still pins the
      // PR's terminal state. Don't move `at`/`ts` (still want recency
      // ordering) but flip the row to merged.
      existing.state = 'merged';
      existing.merged = true;
    }
  }
  const rows = Array.from(byPr.values()).sort((a, b) => b.ts - a.ts);
  return rows.slice(0, MAX_LIST_ITEMS).map(({ ts: _ts, merged: _m, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pull the plan_state value from an atom whether it sits at the top
 * level (per arch-plan-state-top-level-field) or nests under a known
 * metadata key. Returns null when neither path resolves.
 */
function atomPlanState(atom: LiveOpsAtom): string | null {
  const top = (atom as unknown as Record<string, unknown>)['plan_state'];
  if (typeof top === 'string') return top;
  const meta = (atom.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta['plan_state'] === 'string') return meta['plan_state'] as string;
  return null;
}

/**
 * Best-effort plan title resolution. Order:
 *   1. metadata.title  (planning-actor writes this explicitly)
 *   2. first non-empty line of `content` stripped of leading "# "
 *      -- markdown plans typically open with an H1 title line.
 *   3. atom.id  (last-resort fallback so the row never reads empty)
 */
function extractPlanTitle(atom: LiveOpsAtom): string {
  const meta = (atom.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta['title'] === 'string' && meta['title'].length > 0) {
    return meta['title'] as string;
  }
  if (typeof atom.content === 'string') {
    const firstLine = atom.content.split('\n').find((l) => l.trim().length > 0);
    if (firstLine) {
      return firstLine.replace(/^#\s*/, '').trim().slice(0, 200);
    }
  }
  return atom.id;
}
