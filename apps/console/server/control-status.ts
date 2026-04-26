/*
 * Pure helpers for the operator control-panel status handler. Extracted
 * from server/index.ts so the unit tests (server/control-status.test.ts)
 * can import them without triggering the server.listen + file-watcher
 * side effects the entrypoint module carries.
 *
 * Design contract (canon `inv-kill-switch-before-autonomy` +
 * `inv-governance-before-autonomy`): the control panel projects two
 * load-bearing invariants -- the STOP sentinel state and the autonomy
 * tier -- plus four context tiles (actors, policies, last canon-apply
 * timestamp, operator-principal id). Everything is read-only; the
 * handler MUST NOT write the sentinel from the console UI. Engaging
 * the kill switch crosses a higher trust boundary (operator at the
 * shell, with full env), so the UI shows the manual command and lets
 * the operator decide.
 *
 * Path-traversal hardening (two layers):
 *   1. `resolveSentinelInside` is a string-level check: it normalizes
 *      `..` segments via `path.resolve` and rejects any result that
 *      escapes the `.lag` root. Pure (no I/O), deterministic.
 *   2. `readSentinelState` uses `lstat` (not `stat`) so a symlink at
 *      `.lag/STOP -> /etc/passwd` is detected and rejected. Without
 *      the lstat reject, layer 1 would let the symlink through (it is
 *      a string-only check) and `stat` would dereference it, surfacing
 *      the target's mtime as a halt timestamp.
 * The string `.lag/STOP` is a constant that travels with the response
 * so the operator can copy it verbatim for the manual `touch` command.
 */

import { lstat } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';

/*
 * Tier semantics, mapped from the existing kill-switch state file:
 *
 *   - off          -> autonomy_tier: 'soft'   (governance gates active,
 *                                              actors can still run)
 *   - soft         -> autonomy_tier: 'soft'   (UI-engageable; same
 *                                              public posture for v1)
 *   - medium       -> autonomy_tier: 'medium' (CLI-only, more aggressive
 *                                              halt; reserved per
 *                                              kill-switch design)
 *   - hard         -> autonomy_tier: 'hard'   (CLI-only, fully gated)
 *
 * The mapping collapses 'off' -> 'soft' for the operator surface
 * because the operator-readable concept is "what's the active
 * governance posture?" -- a fresh repo with no STOP has the soft
 * default (governance-before-autonomy gates on every write). Medium
 * and hard remain reserved bands per the kill-switch roadmap.
 */
export type ControlTier = 'soft' | 'medium' | 'hard';

export interface ControlKillSwitchSnapshot {
  readonly engaged: boolean;
  readonly sentinel_path: string;
  readonly engaged_at: string | null;
}

export interface ControlStatus {
  readonly kill_switch: ControlKillSwitchSnapshot;
  readonly autonomy_tier: ControlTier;
  readonly actors_governed: number;
  readonly policies_active: number;
  readonly last_canon_apply: string | null;
  readonly operator_principal_id: string;
  readonly recent_kill_switch_transitions: ReadonlyArray<KillSwitchTransitionSummary>;
  readonly active_elevations: ReadonlyArray<ActiveElevationSummary>;
  readonly recent_operator_actions: ReadonlyArray<OperatorActionSummary>;
  readonly recent_escalations: ReadonlyArray<EscalationSummary>;
}

/*
 * Recent kill-switch transitions surfaced on the control panel. The
 * canonical store today is .lag/kill-switch/state.json (current state
 * only; one entry); future writers may persist a per-transition atom
 * with id starting `kill-switch-transition-`. The picker accepts both
 * shapes so the panel surfaces history once that atom type lands
 * without breaking the v1 contract.
 *
 * Capped at MAX_LIST_ITEMS so a runaway history doesn't blow up the
 * payload (per `feedback_security_correctness_at_write_time`: every
 * new list gets a bound at write time).
 */
export interface KillSwitchTransitionSummary {
  readonly tier: 'off' | 'soft' | 'medium' | 'hard';
  readonly at: string;
  readonly transitioned_by: string | null;
  readonly reason: string | null;
  /*
   * Stable identity per row. Set to the source atom id when the row
   * was emitted from a kill-switch-transition-* atom, null when the
   * row reflects the live state-file snapshot (which has no atom of
   * record). The frontend keys React rows on this so two transitions
   * sharing the same (at, tier) tuple do not collide once the
   * per-transition atom writer ships.
   */
  readonly atom_id: string | null;
}

/*
 * Currently-elevated policy atom summary. Surfaces atoms whose
 * `metadata.elevation.expires_at` is still in the future. Each row
 * answers "which policy is elevated, who is the target, and how long
 * until the elevation lapses?". Time-remaining is computed at
 * read-time so the view doesn't need to do its own clock math.
 */
export interface ActiveElevationSummary {
  readonly atom_id: string;
  readonly policy_target: string | null;
  readonly principal: string | null;
  readonly started_at: string | null;
  readonly expires_at: string;
  readonly time_remaining_seconds: number;
}

/*
 * Operator-action summary. Source: atoms whose id begins with
 * `op-action-` (the lag-ceo gh-as audit atoms emitted by
 * scripts/gh-as.mjs). Per `feedback_security_correctness_at_write_time`,
 * we ship ONLY the safe metadata fields (atom id, principal, kind,
 * timestamp). The atom's `content` and `metadata.operator_action.args`
 * frequently embed full GraphQL queries and operator command lines --
 * those stay server-side. The "kind" we surface is the first arg
 * (e.g. "api", "pr", "auth") so the operator sees the shape of recent
 * activity without leaking the body.
 */
export interface OperatorActionSummary {
  readonly atom_id: string;
  readonly principal_id: string;
  readonly kind: string;
  readonly at: string;
}

/*
 * Escalation summary. Source: atoms whose id begins with
 * `dispatch-escalation-` (plan-dispatcher emits these when a sub-actor
 * dispatch fails). Surfaces the atom id + a short reason hint pulled
 * from the content's first line so the operator sees what failed at a
 * glance without expanding the full payload.
 */
export interface EscalationSummary {
  readonly atom_id: string;
  readonly at: string;
  readonly headline: string;
}

/*
 * Per-list cap. 20 keeps each list small enough to render without
 * paginating but large enough that an operator can scan a meaningful
 * window of recent activity. Tuning the cap per list is a follow-up
 * if any one starts dominating the response.
 */
export const MAX_LIST_ITEMS = 20;

/*
 * Display string the UI shows verbatim and the operator copies into a
 * manual `touch` command. Kept as a single source so test + handler
 * cannot drift.
 */
export const SENTINEL_DISPLAY_PATH = '.lag/STOP';

export function tierFromKillSwitch(tier: 'off' | 'soft' | 'medium' | 'hard'): ControlTier {
  switch (tier) {
    case 'medium':
      return 'medium';
    case 'hard':
      return 'hard';
    case 'off':
    case 'soft':
    default:
      return 'soft';
  }
}

/*
 * Resolve the absolute on-disk sentinel path and verify it lives
 * inside the .lag directory. Two layers of defense:
 *   - String-level: `path.resolve` collapses `..` segments, then we
 *     check that the result still lives inside `lagDir` by inspecting
 *     the relative path. A `..` segment that escapes the root, or an
 *     absolute path coming back from `relative` (Windows: different
 *     drive letters), is rejected.
 *   - Filesystem-level: `readSentinelState` uses `lstat` (not `stat`)
 *     and rejects symlinks outright. `path.resolve` never touches the
 *     filesystem, so a symlink at `<lagDir>/STOP` pointing at
 *     `/etc/passwd` would pass the string check; the lstat reject is
 *     what closes that hole.
 *
 * The containment check uses an exact path-segment match (`rel === '..'`
 * or `rel.startsWith('..' + sep)`) so legitimate filenames containing
 * a `..` substring (e.g., `STOP..bak`) are not falsely rejected. The
 * default `relativePath` is the literal `'STOP'` so this path is dead
 * code today, but `relativePath` is a parameter and any future caller
 * composing this helper for another sentinel name should not inherit
 * a filename quirk.
 *
 * Why we do not just use `fs.access`: lstat gives us the mtime, which
 * we surface as `engaged_at` so the operator can see exactly when the
 * sentinel landed. access only answers yes/no.
 */
export function resolveSentinelInside(lagDir: string, relativePath = 'STOP'): string | null {
  const root = resolve(lagDir);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return target;
}

/*
 * Read the sentinel state from disk. Four outcomes:
 *
 *   - regular file present       -> engaged: true, engaged_at: mtime ISO
 *   - file absent                -> engaged: false, engaged_at: null
 *   - resolution rejected (path traversal) -> engaged: false (fail safe);
 *                                              caller still sees the
 *                                              display path so the
 *                                              operator can investigate
 *   - symlink, directory, or any non-regular entry -> engaged: false;
 *                                              the kill-switch contract
 *                                              is "operator created a
 *                                              regular file via touch",
 *                                              and a symlink would let
 *                                              an attacker who can write
 *                                              inside .lag point the
 *                                              sentinel at a target
 *                                              outside the trust
 *                                              boundary and surface that
 *                                              target's mtime.
 *
 * Why lstat (not stat): stat follows symlinks. A symlink at
 * `<lagDir>/STOP -> /etc/passwd` would pass `resolveSentinelInside`
 * (a pure string check) and stat would then return the target's
 * metadata. lstat returns the link itself, and `info.isSymbolicLink()`
 * lets us reject it before the operator sees a halt sourced from
 * outside the .lag dir.
 *
 * fs.lstat MAY throw for reasons other than ENOENT (EACCES, EBUSY).
 * We treat any throw as "not engaged" because the kill-switch
 * invariant says: an absent sentinel means autonomy is not halted. A
 * torn read MUST NOT be silently interpreted as engaged either --
 * that would surprise the operator with a halt that didn't happen.
 */
export async function readSentinelState(absolutePath: string | null): Promise<ControlKillSwitchSnapshot> {
  if (!absolutePath) {
    return { engaged: false, sentinel_path: SENTINEL_DISPLAY_PATH, engaged_at: null };
  }
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { engaged: false, sentinel_path: SENTINEL_DISPLAY_PATH, engaged_at: null };
    }
    return {
      engaged: true,
      sentinel_path: SENTINEL_DISPLAY_PATH,
      engaged_at: info.mtime.toISOString(),
    };
  } catch {
    return { engaged: false, sentinel_path: SENTINEL_DISPLAY_PATH, engaged_at: null };
  }
}

/*
 * Operator-principal candidate shape. Mirrors the load-bearing fields
 * of the server's `Principal` interface so the helper can be tested
 * without dragging the rest of the type in. `role` is part of the
 * signature on purpose: the org convention is that the operator root
 * carries `role: 'apex'` (set by the bootstrap canon), and consumers
 * that compute `actors_governed = principals - apex` rely on that
 * invariant. Surfacing `role` here makes the coupling explicit
 * instead of hiding it behind an undocumented prop access.
 */
export interface OperatorPrincipalCandidate {
  readonly id: string;
  readonly role?: string;
  readonly signed_by?: string | null;
  readonly active?: boolean;
}

/*
 * Pick the operator principal id from a list. Convention in this org:
 *   - the apex (root) principal is the operator -- `signed_by` is
 *     null and `role === 'apex'` (set by the bootstrap canon).
 *   - if any root carries `role: 'apex'`, prefer those over roots
 *     with no role. This makes the apex invariant explicit rather
 *     than implicit, and matches the `actors_governed` count that
 *     filters out apex elsewhere.
 *   - if multiple apex roots exist (rare but legal), pick the first
 *     by id for determinism.
 *   - if no apex root exists but a role-less root does (older
 *     fixture predating the role convention), fall back to that --
 *     this preserves back-compat with v0 fixtures.
 *   - if no roots exist (fresh repo), fall back to the literal string
 *     'unknown' so the UI surfaces the gap rather than crashing.
 *
 * Pure: no I/O, deterministic, easy to test.
 */
export function pickOperatorPrincipalId(
  principals: ReadonlyArray<OperatorPrincipalCandidate>,
): string {
  const roots = principals.filter(
    (p) => (p.signed_by === null || p.signed_by === undefined) && p.active !== false,
  );
  const apexRoots = roots
    .filter((p) => p.role === 'apex')
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b));
  if (apexRoots.length > 0) return apexRoots[0]!;
  const rolelessRoots = roots
    .filter((p) => p.role === undefined)
    .map((p) => p.id)
    .sort((a, b) => a.localeCompare(b));
  return rolelessRoots[0] ?? 'unknown';
}

/*
 * Count atoms representing active governance policies. Convention:
 * canon-layer atoms (L3) with type 'policy' OR id starting with
 * 'pol-' are the governance policy set the kill switch enforces.
 * Superseded or tainted atoms are excluded -- the operator wants to
 * see the LIVE policy count.
 */
export function countActivePolicies(
  atoms: ReadonlyArray<{
    id: string;
    type: string;
    layer?: string;
    superseded_by?: string[];
    taint?: string;
  }>,
): number {
  let n = 0;
  for (const a of atoms) {
    if (a.layer && a.layer !== 'L3') continue;
    if (a.superseded_by && a.superseded_by.length > 0) continue;
    if (a.taint && a.taint !== 'clean') continue;
    if (a.type === 'policy' || a.id.startsWith('pol-')) n++;
  }
  return n;
}

/*
 * Pick the most recent canon-apply marker. Strategy:
 *   - prefer atoms whose type is 'canon-applied' (explicit marker)
 *   - else fall back to the newest L3 atom -- canon is the projection
 *     that gets re-rendered when L3 changes, so the latest L3 write
 *     is a sane proxy for "last canon apply"
 *   - returns the ISO timestamp or null if neither is available
 */
export function pickLastCanonApply(
  atoms: ReadonlyArray<{ type: string; layer?: string; created_at?: string }>,
): string | null {
  let bestExplicit: string | null = null;
  let bestL3: string | null = null;
  for (const a of atoms) {
    const t = a.created_at;
    if (!t) continue;
    if (a.type === 'canon-applied' || a.type === 'canon-apply') {
      if (!bestExplicit || t > bestExplicit) bestExplicit = t;
    }
    if (a.layer === 'L3') {
      if (!bestL3 || t > bestL3) bestL3 = t;
    }
  }
  return bestExplicit ?? bestL3;
}

/*
 * Atom-shape candidate used by the operator-action / elevation /
 * escalation pickers below. Defined inline so the helper module stays
 * decoupled from the server's full `Atom` interface but the field set
 * we depend on is documented at the type layer.
 */
export interface AtomCandidate {
  readonly id: string;
  readonly type?: string;
  readonly layer?: string;
  readonly principal_id?: string;
  readonly created_at?: string;
  readonly content?: string;
  readonly metadata?: Record<string, unknown>;
  readonly superseded_by?: ReadonlyArray<string>;
  readonly taint?: string;
}

/*
 * Recent kill-switch transitions. Two-source merge:
 *   1. `currentState` -- the live entry from .lag/kill-switch/state.json
 *      (reflects the active tier + when it was set). Always rendered as
 *      the most recent transition when present.
 *   2. atoms -- if a future writer persists per-transition atoms (id
 *      prefix `kill-switch-transition-` OR type `kill-switch-transitioned`),
 *      they're folded into the list.
 *
 * The list is sorted descending by `at` and capped at MAX_LIST_ITEMS.
 * `transitioned_by` is the principal id from the state file (or
 * principal_id from the atom). `reason` is whatever free-form note the
 * writer attached (often null).
 *
 * Why merge instead of pick-one: today only the state file exists, so
 * the panel surfaces a single row and the operator sees "current
 * state, set 2 minutes ago by lag-ceo". Once a transition log atom
 * lands, the same picker surfaces history without a second code path.
 */
export function pickRecentKillSwitchTransitions(
  currentState: {
    readonly tier?: 'off' | 'soft' | 'medium' | 'hard' | null;
    readonly since?: string | null;
    readonly reason?: string | null;
    readonly transitioned_by?: string | null;
  } | null,
  atoms: ReadonlyArray<AtomCandidate>,
): KillSwitchTransitionSummary[] {
  const out: KillSwitchTransitionSummary[] = [];
  /*
   * Validate the live-state tier symmetrically with the per-transition atom
   * branch below: `readKillSwitchState()` parses `.lag/kill-switch/state.json`,
   * which can be hand-edited or carry a tier value from a future writer that
   * this build does not recognize. Fail-closed at the picker boundary so the
   * tier badge never receives an unexpected value.
   */
  const VALID_TIERS = ['off', 'soft', 'medium', 'hard'] as const;
  if (
    currentState
    && currentState.tier
    && currentState.since
    && (VALID_TIERS as readonly string[]).includes(currentState.tier)
  ) {
    out.push({
      tier: currentState.tier,
      at: currentState.since,
      transitioned_by: currentState.transitioned_by ?? null,
      reason: currentState.reason ?? null,
      atom_id: null,
    });
  }
  for (const a of atoms) {
    if (a.superseded_by && a.superseded_by.length > 0) continue;
    if (a.taint && a.taint !== 'clean') continue;
    const idMatch = a.id.startsWith('kill-switch-transition-');
    const typeMatch = a.type === 'kill-switch-transitioned' || a.type === 'kill-switch.transitioned';
    if (!idMatch && !typeMatch) continue;
    if (!a.created_at) continue;
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const tier = typeof meta.tier === 'string' ? (meta.tier as KillSwitchTransitionSummary['tier']) : null;
    if (!tier || !['off', 'soft', 'medium', 'hard'].includes(tier)) continue;
    out.push({
      tier,
      at: a.created_at,
      transitioned_by: a.principal_id ?? null,
      reason: typeof meta.reason === 'string' ? meta.reason : null,
      atom_id: a.id,
    });
  }
  out.sort((x, y) => (y.at < x.at ? -1 : y.at > x.at ? 1 : 0));
  return out.slice(0, MAX_LIST_ITEMS);
}

/*
 * Active elevations. Source: atoms whose
 * `metadata.elevation.expires_at` is a parseable ISO timestamp in the
 * future (vs `now`). Superseded or tainted atoms are excluded. The
 * caller injects `nowMs` so the helper stays pure (testable without a
 * fake clock module).
 *
 * `policy_target` and `principal` come from `metadata.policy.tool` and
 * `metadata.policy.principal` when present (the canonical operator-
 * elevation atom shape). They're null when the atom uses a different
 * convention -- the panel just shows the atom id in that case.
 */
export function pickActiveElevations(
  atoms: ReadonlyArray<AtomCandidate>,
  nowMs: number,
): ActiveElevationSummary[] {
  const out: ActiveElevationSummary[] = [];
  for (const a of atoms) {
    if (a.superseded_by && a.superseded_by.length > 0) continue;
    if (a.taint && a.taint !== 'clean') continue;
    /*
     * Symmetric id-prefix / type guard: the other three pickers in this
     * file (`pickRecentKillSwitchTransitions`, `pickRecentOperatorActions`,
     * `pickRecentEscalations`) gate on id-prefix or type. Match that
     * pattern for elevations so a stray atom carrying `metadata.elevation`
     * but not authored as a policy atom (test fixture, hand-written
     * scratch atom, future writer using a different convention) cannot
     * leak into the panel. Canonical operator-elevation atoms use the
     * `pol-` prefix and `type === 'policy'` (or omit type entirely).
     */
    const idMatch = a.id.startsWith('pol-');
    const typeMatch = a.type === undefined || a.type === 'policy';
    if (!idMatch || !typeMatch) continue;
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const elevation = meta.elevation as Record<string, unknown> | undefined;
    if (!elevation || typeof elevation !== 'object') continue;
    const expiresAt = elevation.expires_at;
    if (typeof expiresAt !== 'string') continue;
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) continue;
    if (expiresMs <= nowMs) continue;
    const startedAt = typeof elevation.started_at === 'string' ? elevation.started_at : null;
    const policy = (meta.policy as Record<string, unknown> | undefined) ?? {};
    const tool = typeof policy.tool === 'string' ? policy.tool : null;
    const subject = typeof policy.subject === 'string' ? policy.subject : null;
    const principal = typeof policy.principal === 'string' ? policy.principal : null;
    out.push({
      atom_id: a.id,
      policy_target: tool ?? subject ?? null,
      principal,
      started_at: startedAt,
      expires_at: expiresAt,
      time_remaining_seconds: Math.max(0, Math.floor((expiresMs - nowMs) / 1000)),
    });
  }
  out.sort((x, y) => (x.expires_at < y.expires_at ? -1 : x.expires_at > y.expires_at ? 1 : 0));
  return out.slice(0, MAX_LIST_ITEMS);
}

/*
 * Recent operator actions. Source: atoms whose id begins with
 * `op-action-`. Surfaces only the safe summary fields:
 *   - atom_id    -- so the operator can drill down via the Atoms view
 *   - principal_id -- the bot or operator that ran the action
 *   - kind       -- the first arg from metadata.operator_action.args
 *                   (e.g. "api", "pr", "graphql"); the rest of the
 *                   args (which can include GraphQL queries with PII
 *                   hints, repo paths, full operator command lines)
 *                   stay server-side.
 *   - at         -- created_at ISO
 *
 * Sorted descending by `at`, capped at MAX_LIST_ITEMS.
 */
export function pickRecentOperatorActions(
  atoms: ReadonlyArray<AtomCandidate>,
): OperatorActionSummary[] {
  const out: OperatorActionSummary[] = [];
  for (const a of atoms) {
    if (!a.id.startsWith('op-action-')) continue;
    if (a.superseded_by && a.superseded_by.length > 0) continue;
    if (a.taint && a.taint !== 'clean') continue;
    if (!a.created_at) continue;
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const op = meta.operator_action as Record<string, unknown> | undefined;
    let kind = 'unknown';
    if (op && Array.isArray(op.args) && op.args.length > 0 && typeof op.args[0] === 'string') {
      /*
       * Cap the surfaced kind at 32 chars so a malformed first arg can't
       * blow up the response payload size or the rendered cell width.
       */
      kind = (op.args[0] as string).slice(0, 32);
    }
    out.push({
      atom_id: a.id,
      principal_id: a.principal_id ?? 'unknown',
      kind,
      at: a.created_at,
    });
  }
  out.sort((x, y) => (y.at < x.at ? -1 : y.at > x.at ? 1 : 0));
  /*
   * Cap at MAX_LIST_ITEMS / 2 so the operator-actions list doesn't
   * dominate the panel when other lists are present. 10 rows mirrors
   * the "top 10 recent operator-actions" ask in the v1 spec.
   */
  return out.slice(0, Math.min(10, MAX_LIST_ITEMS));
}

/*
 * Recent escalations. Source: atoms whose id begins with
 * `dispatch-escalation-`. Surfaces atom id + a short headline (first
 * line of content, capped at 160 chars) so the operator sees the
 * shape of recent failures without expanding the full payload.
 */
export function pickRecentEscalations(
  atoms: ReadonlyArray<AtomCandidate>,
): EscalationSummary[] {
  const out: EscalationSummary[] = [];
  for (const a of atoms) {
    if (!a.id.startsWith('dispatch-escalation-')) continue;
    if (a.superseded_by && a.superseded_by.length > 0) continue;
    if (a.taint && a.taint !== 'clean') continue;
    if (!a.created_at) continue;
    const firstLine = typeof a.content === 'string'
      ? (a.content.split(/\r?\n/, 1)[0] ?? '').slice(0, 160)
      : '';
    out.push({
      atom_id: a.id,
      at: a.created_at,
      headline: firstLine,
    });
  }
  out.sort((x, y) => (y.at < x.at ? -1 : y.at > x.at ? 1 : 0));
  return out.slice(0, MAX_LIST_ITEMS);
}
