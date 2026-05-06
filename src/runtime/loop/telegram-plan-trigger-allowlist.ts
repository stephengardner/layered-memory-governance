/**
 * Canon reader for the telegram-plan-trigger principal allowlist.
 *
 * Mirrors the read shape of `readApprovalCycleTickIntervalMs` and
 * `readPrObservationFreshnessMs`: scan canon directive atoms for
 * `metadata.policy.subject === 'telegram-plan-trigger-principals'`,
 * read `policy.principal_ids` as the allowlist. Falls back to
 * DEFAULT_PRINCIPAL_ALLOWLIST when no policy atom exists or the
 * value is malformed (non-array, non-string entries, etc).
 *
 * An explicitly EMPTY array in the policy atom is honored -- that is
 * the explicit opt-out path for deployments that want the notify
 * pass enabled without any principal triggering it (e.g. a smoke-
 * test deployment, or an org-wide pause). The fallback only triggers
 * on absent / malformed payloads.
 *
 * Substrate purity: this reader is mechanism-only. It does not
 * encode principal names in framework code beyond the indie-floor
 * defaults documented as the seed-canon shape; an org-ceiling
 * deployment overrides the entire list via the policy atom.
 */

import type { Host } from '../../interface.js';
import type { PrincipalId } from '../../types.js';

/**
 * Default indie-floor allowlist. The concrete principal names
 * encoded here are the framework's no-canon fallback so a fresh
 * deployment without a seeded policy atom still gets a useful
 * notify pass. The seed canon written by the bootstrap script
 * (under scripts/) carries the same names, and the policy atom is
 * authoritative the moment it lands. Org-ceiling deployments
 * override the entire set via the canon policy atom rather than
 * editing this constant.
 */
export const DEFAULT_PRINCIPAL_ALLOWLIST: ReadonlyArray<PrincipalId> = Object.freeze([
  'cto-actor' as PrincipalId,
  'cpo-actor' as PrincipalId,
]);

/**
 * Read the configured principal allowlist from canon. Falls back to
 * DEFAULT_PRINCIPAL_ALLOWLIST when no policy atom exists or the
 * payload is malformed. Returns an empty list when the policy atom
 * exists with an explicitly empty principal_ids array (the explicit
 * opt-out).
 *
 * Tainted or superseded canon atoms are ignored. The first matching
 * untainted unsuperseded atom wins; later matches with the same
 * subject are not aggregated (priority + scope arbitration is the
 * substrate's responsibility, not this reader's).
 */
export async function readPlanTriggerAllowlist(host: Host): Promise<ReadonlyArray<PrincipalId>> {
  const PAGE_SIZE = 200;
  let cursor: string | undefined;
  do {
    const page = await host.atoms.query({ type: ['directive'] }, PAGE_SIZE, cursor);
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (atom.superseded_by.length > 0) continue;
      const meta = atom.metadata as Record<string, unknown>;
      const policy = meta['policy'] as Record<string, unknown> | undefined;
      if (!policy || policy['subject'] !== 'telegram-plan-trigger-principals') continue;
      const raw = policy['principal_ids'];
      if (!Array.isArray(raw)) continue;
      // Validate every entry: non-empty string. A single bad entry
      // invalidates the whole policy and falls through to defaults
      // rather than silently dropping bad entries (which would let
      // a typo'd principal stay in the allowlist forever
      // invisibly). The explicit-empty-array opt-out path passes
      // this guard trivially because there are no entries to
      // validate.
      const valid = raw.every((p) => typeof p === 'string' && p.length > 0);
      if (!valid) continue;
      return Object.freeze(raw.map((p) => p as PrincipalId));
    }
    cursor = page.nextCursor === null ? undefined : page.nextCursor;
  } while (cursor !== undefined);
  return DEFAULT_PRINCIPAL_ALLOWLIST;
}
