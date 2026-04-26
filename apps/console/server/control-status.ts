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
}

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
