/**
 * Verified citation set: closure of citations across the deep planning
 * pipeline.
 *
 * The set is built from the seed atoms (the operator-intent that
 * authorised the run) plus every L3 directive canon atom whose scope
 * applies to the requested ctx scope (default 'project'). The runner
 * forwards this set to every stage's StageInput.verifiedCitedAtomIds;
 * stage adapters that drive an LLM put the set into their data block
 * under `verified_cited_atom_ids` and instruct the LLM in the system
 * prompt to ground every atom-id citation in the set.
 *
 * Tainted and superseded atoms are excluded so the citation fence
 * never widens past the arbitration stack's authoritative-atoms
 * predicate.
 *
 * Mechanism only: the helper does not interpret canon content; it
 * yields atom ids. Stage adapters are responsible for any further
 * filtering (e.g. principle-only subset for plan-stage's
 * principles_applied field).
 *
 * Bounded by MAX_VERIFIED_SCAN to prevent a runaway loop on a
 * malformed atom store; partial reads return what was scanned rather
 * than throwing because an empty verified set is a load-bearing signal
 * the stage prompts already understand (cite nothing).
 */

const MAX_VERIFIED_SCAN = 10_000;
const PAGE_SIZE = 200;

/**
 * Compute the verified citation set the runner forwards into every
 * stage's StageInput.
 *
 * @param {{ atoms: { query: (filter: object, limit: number, cursor?: string) => Promise<{ atoms: ReadonlyArray<object>, nextCursor: string | null }> } }} host
 *   Host shape exposing host.atoms.query. Accepts the full Host or a
 *   structurally-compatible test double.
 * @param {{ seedAtomIds: ReadonlyArray<string>, scope: string }} opts
 * @returns {Promise<ReadonlyArray<string>>}
 */
export async function computeVerifiedCitedAtomIds(host, opts) {
  const verified = [];
  const seen = new Set();
  // Seed atoms always belong in the verified set; the operator-intent
  // is the authorising root, so the chain's first link MUST be
  // citable.
  for (const seedId of opts.seedAtomIds) {
    const idStr = String(seedId);
    if (!seen.has(idStr)) {
      seen.add(idStr);
      verified.push(seedId);
    }
  }
  let totalSeen = 0;
  let cursor;
  while (totalSeen < MAX_VERIFIED_SCAN) {
    const remaining = MAX_VERIFIED_SCAN - totalSeen;
    const page = await host.atoms.query(
      { type: ['directive'], layer: ['L3'] },
      Math.min(PAGE_SIZE, remaining),
      cursor,
    );
    // Defensive: a page with zero atoms but a non-null nextCursor
    // would never advance totalSeen and the loop would spin forever.
    // Treat any empty page as the end of the iteration regardless of
    // the cursor; a malformed adapter that paginates infinitely with
    // zero-atom pages is a fail-closed condition (the verified set is
    // partial, but the loop returns).
    if (page.atoms.length === 0) {
      break;
    }
    for (const atom of page.atoms) {
      if (atom.taint !== 'clean') continue;
      if (Array.isArray(atom.superseded_by) && atom.superseded_by.length > 0) continue;
      // scope check mirrors src/runtime/planning-pipeline/policy.ts:
      // 'project' applies everywhere; 'feature:<id>' / 'principal:<id>'
      // apply only on exact match.
      const atomScope = typeof atom.scope === 'string' ? atom.scope : 'project';
      const ctxScope = opts.scope;
      const scopeApplies =
        atomScope === 'project' || atomScope === ctxScope;
      if (!scopeApplies) continue;
      const idStr = String(atom.id);
      if (seen.has(idStr)) continue;
      seen.add(idStr);
      verified.push(atom.id);
    }
    totalSeen += page.atoms.length;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return verified;
}
