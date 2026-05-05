/**
 * Pure helpers for the resume-audit dashboard surface.
 *
 * Reads `agent-session` and `resume-reset` atom shapes (defined by the
 * resume-by-default extension phases 1-3) from a flat atom array and
 * projects three response shapes:
 *
 *   - `summarizeResumeStats`  : per-principal resume-vs-fresh-spawn ratio
 *   - `listRecentResumed`     : N most recent sessions that wrote a `resume_attempt`
 *   - `listRecentResets`      : N most recent `resume-reset` atoms (with consumed flag)
 *
 * Design constraints baked into this module (mirrors `live-ops.ts`,
 * `pipelines.ts`, `actor-activity.ts`):
 *   - Pure functions, no I/O. The handler in server/index.ts feeds
 *     this module the full atom array.
 *   - Read-only by construction.
 *   - Bounded payload caps (DoS defense).
 *   - UTC ISO timestamps assumed.
 *   - Deterministic against a pinned `now` so window-boundary
 *     assertions stay stable across machines.
 *
 * The `resume_attempt` ENUM lives in `resume-audit-types.ts` and is
 * the single source of truth for valid values; unknown / absent values
 * collapse to the `unknown` sentinel so a dashboard render never
 * crashes on a malformed atom.
 */

import type {
  ResumeAttemptKind,
  ResumeAuditPrincipalStats,
  ResumeAuditRecentResponse,
  ResumeAuditRecentSession,
  ResumeAuditResetRecord,
  ResumeAuditResetsResponse,
  ResumeAuditSourceAtom,
  ResumeAuditSummary,
} from './resume-audit-types.js';
import {
  RESUME_AUDIT_DEFAULT_LIMIT,
  RESUME_AUDIT_DEFAULT_WINDOW_HOURS,
  RESUME_AUDIT_MAX_LIST_ITEMS,
  RESUME_AUDIT_MAX_WINDOW_HOURS,
  RESUME_AUDIT_MIN_WINDOW_HOURS,
} from './resume-audit-types.js';
import { readString } from './projection-helpers.js';

// ---------------------------------------------------------------------------
// Internal helpers (mirror the same shape as pipelines.ts).
// ---------------------------------------------------------------------------

function parseIsoTs(value: string | undefined | null): number {
  if (typeof value !== 'string' || value.length === 0) return NaN;
  return Date.parse(value);
}

function readMeta(atom: ResumeAuditSourceAtom): Record<string, unknown> {
  return (atom.metadata ?? {}) as Record<string, unknown>;
}

function isCleanLive(atom: ResumeAuditSourceAtom): boolean {
  // Live atoms have an unset taint or the canonical 'clean' sentinel.
  // Mirrors the pipelines.ts isCleanLive guard. Earlier shape
  // `if (atom.taint) return false` was wrong because every well-formed
  // atom carries `taint: 'clean'` (a truthy string) and was therefore
  // filtered out.
  if (atom.taint && atom.taint !== 'clean') return false;
  if (atom.superseded_by && atom.superseded_by.length > 0) return false;
  return true;
}

/**
 * Pull the resume-related fields off a `metadata.agent_session.extra`
 * object. Returns the canonical shape with `unknown` substituted for
 * any missing-or-malformed `resume_attempt` value, so the projection
 * downstream can branch on a finite ENUM.
 */
function readResumeFields(atom: ResumeAuditSourceAtom): {
  attempt: ResumeAttemptKind;
  strategy: string | null;
  resumedFrom: string | null;
  modelId: string | null;
  adapterId: string | null;
  workspaceId: string | null;
} {
  const meta = readMeta(atom);
  const session = meta['agent_session'];
  if (!session || typeof session !== 'object') {
    return {
      attempt: 'unknown',
      strategy: null,
      resumedFrom: null,
      modelId: null,
      adapterId: null,
      workspaceId: null,
    };
  }
  const sessionMeta = session as Record<string, unknown>;
  const extraRaw = sessionMeta['extra'];
  const extra = (extraRaw && typeof extraRaw === 'object'
    ? (extraRaw as Record<string, unknown>)
    : {});
  const rawAttempt = extra['resume_attempt'];
  const attempt: ResumeAttemptKind
    = typeof rawAttempt === 'string' && isResumeAttemptKind(rawAttempt)
      ? rawAttempt
      : 'unknown';
  const strategy = typeof extra['resume_strategy_used'] === 'string'
    ? (extra['resume_strategy_used'] as string)
    : null;
  const resumedFrom = typeof extra['resumed_from_atom_id'] === 'string'
    ? (extra['resumed_from_atom_id'] as string)
    : null;
  return {
    attempt,
    strategy,
    resumedFrom,
    modelId: readString(sessionMeta, 'model_id'),
    adapterId: readString(sessionMeta, 'adapter_id'),
    workspaceId: readString(sessionMeta, 'workspace_id'),
  };
}

function isResumeAttemptKind(value: string): value is ResumeAttemptKind {
  return (
    value === 'resumed'
    || value === 'fresh-spawn-no-strategy'
    || value === 'fresh-spawn-fallback'
    || value === 'fresh-spawn-reset'
    || value === 'fresh-spawn-policy-disabled'
  );
}

function isFreshSpawnAttempt(kind: ResumeAttemptKind): boolean {
  return (
    kind === 'fresh-spawn-no-strategy'
    || kind === 'fresh-spawn-fallback'
    || kind === 'fresh-spawn-reset'
    || kind === 'fresh-spawn-policy-disabled'
  );
}

/**
 * Clamp the operator-supplied window to the supported range. The
 * helper is exported so the route handler can apply the same clamp
 * before producing the response so `summary.window_hours` reflects
 * the effective value, not the requested one.
 */
export function clampWindowHours(requested: number | null | undefined): number {
  if (requested === null || requested === undefined || !Number.isFinite(requested)) {
    return RESUME_AUDIT_DEFAULT_WINDOW_HOURS;
  }
  if (requested < RESUME_AUDIT_MIN_WINDOW_HOURS) return RESUME_AUDIT_MIN_WINDOW_HOURS;
  if (requested > RESUME_AUDIT_MAX_WINDOW_HOURS) return RESUME_AUDIT_MAX_WINDOW_HOURS;
  return requested;
}

/**
 * Clamp the operator-supplied limit to the supported range. Default
 * is `RESUME_AUDIT_DEFAULT_LIMIT`; values above
 * `RESUME_AUDIT_MAX_LIST_ITEMS` are silently clamped to defend
 * against a misconfigured client polling for the whole store.
 */
export function clampLimit(requested: number | null | undefined): number {
  if (requested === null || requested === undefined || !Number.isFinite(requested)) {
    return RESUME_AUDIT_DEFAULT_LIMIT;
  }
  if (requested < 1) return 1;
  if (requested > RESUME_AUDIT_MAX_LIST_ITEMS) return RESUME_AUDIT_MAX_LIST_ITEMS;
  return Math.floor(requested);
}

// ---------------------------------------------------------------------------
// Projection 1: per-principal stats over a window.
// ---------------------------------------------------------------------------

/**
 * Build the summary projection: per-principal resume-vs-fresh-spawn
 * stats over a time window. Sessions older than the window are
 * excluded; sessions with no `resume_attempt` field still count
 * toward `total_sessions` so an operator can see "this principal had
 * 12 sessions but no resume telemetry yet" as a distinct state from
 * "this principal had 0 sessions."
 *
 * Sort: principals ordered by `total_sessions` DESC then id ASC so the
 * dashboard ranks the busiest principals first; ties break
 * deterministically by id.
 */
export function summarizeResumeStats(
  atoms: ReadonlyArray<ResumeAuditSourceAtom>,
  now: number,
  windowHours: number = RESUME_AUDIT_DEFAULT_WINDOW_HOURS,
): ResumeAuditSummary {
  const effectiveWindow = clampWindowHours(windowHours);
  const cutoff = now - effectiveWindow * 3600 * 1000;
  const cutoffIso = new Date(cutoff).toISOString();

  const sessionAtoms = atoms.filter(
    (a) => a.type === 'agent-session' && isCleanLive(a),
  );

  // Bucket by principal_id.
  const byPrincipal = new Map<string, MutableStats>();
  let totalSessions = 0;
  let totalResumeAttempts = 0;
  let totalResumed = 0;
  for (const atom of sessionAtoms) {
    const ts = parseIsoTs(atom.created_at);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    totalSessions += 1;
    const fields = readResumeFields(atom);
    const principalId = atom.principal_id || '(unknown)';
    let entry = byPrincipal.get(principalId);
    if (!entry) {
      entry = {
        principalId,
        totalSessions: 0,
        resumeAttempts: 0,
        resumedCount: 0,
        freshSpawnCount: 0,
        lastSessionTs: -Infinity,
        lastSessionIso: null,
      };
      byPrincipal.set(principalId, entry);
    }
    entry.totalSessions += 1;
    if (ts > entry.lastSessionTs) {
      entry.lastSessionTs = ts;
      entry.lastSessionIso = atom.created_at;
    }
    if (fields.attempt !== 'unknown') {
      entry.resumeAttempts += 1;
      totalResumeAttempts += 1;
      if (fields.attempt === 'resumed') {
        entry.resumedCount += 1;
        totalResumed += 1;
      } else if (isFreshSpawnAttempt(fields.attempt)) {
        entry.freshSpawnCount += 1;
      }
    }
  }

  const principals: ResumeAuditPrincipalStats[] = [];
  for (const stats of byPrincipal.values()) {
    const ratio = stats.resumeAttempts === 0
      ? null
      : stats.resumedCount / stats.resumeAttempts;
    principals.push({
      principal_id: stats.principalId,
      total_sessions: stats.totalSessions,
      resume_attempts: stats.resumeAttempts,
      resumed_count: stats.resumedCount,
      fresh_spawn_count: stats.freshSpawnCount,
      ratio,
      last_session_at: stats.lastSessionIso,
    });
  }
  principals.sort((a, b) => {
    if (a.total_sessions !== b.total_sessions) return b.total_sessions - a.total_sessions;
    return a.principal_id.localeCompare(b.principal_id);
  });

  return {
    window_hours: effectiveWindow,
    window_start_at: cutoffIso,
    generated_at: new Date(now).toISOString(),
    principals,
    total_sessions: totalSessions,
    total_resume_attempts: totalResumeAttempts,
    total_resumed: totalResumed,
  };
}

interface MutableStats {
  principalId: string;
  totalSessions: number;
  resumeAttempts: number;
  resumedCount: number;
  freshSpawnCount: number;
  lastSessionTs: number;
  lastSessionIso: string | null;
}

// ---------------------------------------------------------------------------
// Projection 2: most recent resumed sessions.
// ---------------------------------------------------------------------------

/**
 * Return the N most recent `agent-session` atoms whose
 * `extra.resume_attempt` is `'resumed'`. Sessions that fresh-spawned
 * (any of the four `fresh-spawn-*` kinds) are excluded; the dashboard
 * has a separate "ratio" surface for those, and the recent list is
 * intentionally focused on resume successes for quick "did the resume
 * pick up the right session?" inspection.
 *
 * Sort: `created_at` DESC, ties broken by atom id ASC for determinism.
 */
export function listRecentResumed(
  atoms: ReadonlyArray<ResumeAuditSourceAtom>,
  now: number,
  limit: number = RESUME_AUDIT_DEFAULT_LIMIT,
): ResumeAuditRecentResponse {
  const effectiveLimit = clampLimit(limit);
  const sessions: ResumeAuditRecentSession[] = [];
  for (const atom of atoms) {
    if (atom.type !== 'agent-session' || !isCleanLive(atom)) continue;
    const fields = readResumeFields(atom);
    if (fields.attempt !== 'resumed') continue;
    sessions.push({
      session_atom_id: atom.id,
      principal_id: atom.principal_id || '(unknown)',
      created_at: atom.created_at,
      resume_attempt: fields.attempt,
      resume_strategy_used: fields.strategy,
      resumed_from_atom_id: fields.resumedFrom,
      model_id: fields.modelId,
      adapter_id: fields.adapterId,
      workspace_id: fields.workspaceId,
    });
  }
  sessions.sort((a, b) => {
    const tb = parseIsoTs(b.created_at);
    const ta = parseIsoTs(a.created_at);
    if (tb !== ta) return tb - ta;
    return a.session_atom_id.localeCompare(b.session_atom_id);
  });
  return {
    sessions: sessions.slice(0, effectiveLimit),
    generated_at: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Projection 3: most recent resume-reset atoms.
// ---------------------------------------------------------------------------

/**
 * Return the N most recent `resume-reset` atoms. The `consumed` flag
 * is computed by checking for any `resume-reset-consumed` atom whose
 * `metadata.reset_atom_id` references this reset's id; the substrate
 * writes that consumed atom when the wrapper observes the reset
 * during a fresh-spawn (per spec section 6.4).
 */
export function listRecentResets(
  atoms: ReadonlyArray<ResumeAuditSourceAtom>,
  now: number,
  limit: number = RESUME_AUDIT_DEFAULT_LIMIT,
): ResumeAuditResetsResponse {
  const effectiveLimit = clampLimit(limit);

  // Build a quick set of consumed reset ids for O(N+M) lookup. The
  // consumed atom carries `metadata.reset.consumed_atom_id` (or
  // `metadata.reset_atom_id` depending on substrate version) pointing
  // at the original reset; we accept either shape so a future
  // substrate rename does not silently break the badge.
  const consumedIds = new Set<string>();
  for (const atom of atoms) {
    if (atom.type !== 'resume-reset-consumed' || !isCleanLive(atom)) continue;
    const meta = readMeta(atom);
    const resetMeta = meta['reset'];
    let resetId: string | null = null;
    if (resetMeta && typeof resetMeta === 'object') {
      const inner = resetMeta as Record<string, unknown>;
      if (typeof inner['consumed_atom_id'] === 'string') {
        resetId = inner['consumed_atom_id'] as string;
      } else if (typeof inner['reset_atom_id'] === 'string') {
        resetId = inner['reset_atom_id'] as string;
      }
    }
    if (resetId === null && typeof meta['reset_atom_id'] === 'string') {
      resetId = meta['reset_atom_id'] as string;
    }
    if (resetId) consumedIds.add(resetId);
  }

  const records: ResumeAuditResetRecord[] = [];
  for (const atom of atoms) {
    if (atom.type !== 'resume-reset' || !isCleanLive(atom)) continue;
    const meta = readMeta(atom);
    const resetMeta = meta['reset'];
    let resetPrincipal = atom.principal_id;
    let workItemKind: string | null = null;
    let workItemSummary: string | null = null;
    let reason: string | null = null;
    if (resetMeta && typeof resetMeta === 'object') {
      const inner = resetMeta as Record<string, unknown>;
      if (typeof inner['principal_id'] === 'string') {
        resetPrincipal = inner['principal_id'] as string;
      }
      if (typeof inner['reason'] === 'string') {
        reason = inner['reason'] as string;
      }
      const workItem = inner['work_item_key'];
      if (workItem && typeof workItem === 'object') {
        const wi = workItem as Record<string, unknown>;
        if (typeof wi['kind'] === 'string') workItemKind = wi['kind'] as string;
        workItemSummary = describeWorkItem(wi);
      }
    }
    records.push({
      atom_id: atom.id,
      created_at: atom.created_at,
      principal_id: atom.principal_id || '(unknown)',
      reset_principal_id: resetPrincipal || '(unknown)',
      work_item_kind: workItemKind,
      work_item_summary: workItemSummary,
      reason,
      consumed: consumedIds.has(atom.id),
    });
  }
  records.sort((a, b) => {
    const tb = parseIsoTs(b.created_at);
    const ta = parseIsoTs(a.created_at);
    if (tb !== ta) return tb - ta;
    return a.atom_id.localeCompare(b.atom_id);
  });
  return {
    resets: records.slice(0, effectiveLimit),
    generated_at: new Date(now).toISOString(),
  };
}

/**
 * One-line description of a `WorkItemKey` for display in the resets
 * list. The shape lives in `examples/agent-loops/resume-author/registry.ts`
 * (per the spec) but it's simple enough that the dashboard can decode
 * it without importing the registry. New shapes added there should
 * extend this switch; missing kinds fall back to JSON-stringification
 * so the row stays informative.
 */
function describeWorkItem(wi: Record<string, unknown>): string {
  const kind = typeof wi['kind'] === 'string' ? (wi['kind'] as string) : null;
  switch (kind) {
    case 'pr': {
      const owner = typeof wi['owner'] === 'string' ? (wi['owner'] as string) : '?';
      const repo = typeof wi['repo'] === 'string' ? (wi['repo'] as string) : '?';
      const num = typeof wi['number'] === 'number' ? (wi['number'] as number) : '?';
      return `PR ${owner}/${repo}#${num}`;
    }
    case 'intent': {
      const id = typeof wi['intentAtomId'] === 'string' ? (wi['intentAtomId'] as string) : '?';
      return `intent ${id}`;
    }
    case 'plan': {
      const id = typeof wi['planAtomId'] === 'string' ? (wi['planAtomId'] as string) : '?';
      return `plan ${id}`;
    }
    case 'pipeline-stage': {
      const pipelineId = typeof wi['pipelineId'] === 'string' ? (wi['pipelineId'] as string) : '?';
      const stageName = typeof wi['stageName'] === 'string' ? (wi['stageName'] as string) : '?';
      return `${pipelineId} / ${stageName}`;
    }
    case 'audit': {
      const id = typeof wi['auditedAtomId'] === 'string' ? (wi['auditedAtomId'] as string) : '?';
      const auditKind = typeof wi['auditKind'] === 'string' ? (wi['auditKind'] as string) : '?';
      return `audit ${auditKind} on ${id}`;
    }
    case 'custom': {
      const principal = typeof wi['principalId'] === 'string' ? (wi['principalId'] as string) : '?';
      const key = typeof wi['key'] === 'string' ? (wi['key'] as string) : '?';
      return `${principal} / ${key}`;
    }
    default:
      return JSON.stringify(wi).slice(0, 120);
  }
}
