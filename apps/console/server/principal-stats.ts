/**
 * Pure-function helper for the principal-stats projection.
 *
 * Aggregates per-principal atom counts by type so the Console can
 * surface a chip row on each PrincipalCard ("X plans, Y observations,
 * Z decisions"). Stays out of the HTTP plumbing so vitest can
 * exercise the aggregation without standing up a server or touching
 * disk.
 *
 * Reads the canon `arch-atomstore-source-of-truth`: this is a
 * projection over the atom set, not a separate write. The handler
 * passes the live atom snapshot from the in-memory index; this
 * function just reduces.
 */

export interface PrincipalStatsAtom {
  readonly principal_id: string;
  readonly type: string;
  readonly superseded_by?: ReadonlyArray<string>;
  readonly taint?: string;
}

/**
 * Counts of live atoms authored by a single principal, broken out by
 * type. The wire shape is stable: callers index by type string and
 * fall through to 0 for unknown types.
 */
export interface PrincipalStats {
  /** Total live atoms across all types. */
  readonly total: number;
  /** Per-type counts. Types not present are absent from the map. */
  readonly by_type: Readonly<Record<string, number>>;
}

export interface PrincipalStatsResponse {
  /** Map of principal_id -> stats. Principals with zero atoms are omitted. */
  readonly stats: Readonly<Record<string, PrincipalStats>>;
  /** ISO timestamp of when the server computed this snapshot. */
  readonly generated_at: string;
}

function isLive(a: PrincipalStatsAtom): boolean {
  if (a.superseded_by && a.superseded_by.length > 0) return false;
  if (a.taint && a.taint !== 'clean') return false;
  return true;
}

/**
 * Pure transform. Given the live atom snapshot, return per-principal
 * type counts. Superseded and tainted atoms are filtered out so the
 * counts reflect what an operator sees in the activity feed.
 */
export function buildPrincipalStatsResponse(
  atoms: ReadonlyArray<PrincipalStatsAtom>,
  now: Date,
): PrincipalStatsResponse {
  const byPrincipal = new Map<string, Map<string, number>>();
  for (const atom of atoms) {
    if (!isLive(atom)) continue;
    if (typeof atom.principal_id !== 'string' || atom.principal_id.length === 0) continue;
    let typeMap = byPrincipal.get(atom.principal_id);
    if (!typeMap) {
      typeMap = new Map<string, number>();
      byPrincipal.set(atom.principal_id, typeMap);
    }
    typeMap.set(atom.type, (typeMap.get(atom.type) ?? 0) + 1);
  }
  const stats: Record<string, PrincipalStats> = {};
  for (const [principalId, typeMap] of byPrincipal.entries()) {
    const by_type: Record<string, number> = {};
    let total = 0;
    for (const [type, count] of typeMap.entries()) {
      by_type[type] = count;
      total += count;
    }
    stats[principalId] = { total, by_type };
  }
  return { stats, generated_at: now.toISOString() };
}
