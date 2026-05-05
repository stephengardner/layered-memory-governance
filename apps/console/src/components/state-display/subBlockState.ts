/**
 * Render-decision helper for sub-block useQuery callsites.
 *
 * Five sub-block components in the Console all share the same query
 * lifecycle shape:
 *   1. While pending  -> render nothing (parent surface already shows
 *      a top-level loading state; an in-card spinner would be noisy).
 *   2. On error       -> render an InlineError hint. Earlier these
 *      silent-absorbed errors as "no data" because step 4 was the only
 *      branch that mounted UI.
 *   3. When empty     -> render nothing (the section is opt-in; an
 *      "empty" header pollutes the expanded-card stack).
 *   4. With items     -> render the section content.
 *
 * Extracting this decision per dev-extract-at-n-equals-2: the same
 * `if (query.isPending || items.length === 0) return null` ladder
 * appeared in CanonCard.ReferencedBy, WhyThisAtom, CascadeIfTainted,
 * AtomDetailView.ReferencedByBlock, and PrincipalsView.statsQuery.
 * Extending the ladder with an `if (query.isError)` branch in five
 * places would drift; one helper means the contract lives in one
 * file with one set of tests.
 *
 * The helper is a pure function over a small slice of the TanStack
 * Query state shape (`isPending`, `isError`, `error`) plus an
 * `isEmpty` predicate the caller computes from `query.data`. Returning
 * a tagged union keeps the caller side trivial: a single switch maps
 * each tag to a piece of JSX.
 */

export type SubBlockState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'empty' }
  | { readonly kind: 'content' };

interface QuerySlice {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
}

/**
 * Map a TanStack Query slice + caller-computed `isEmpty` to the
 * render-decision tag. `isEmpty` is the caller's responsibility
 * because the empty predicate differs per sub-block (`refs.length
 * === 0`, `chain.length === 0`, `Object.keys(stats).length === 0`,
 * etc.) and threading the `data` shape into this helper would couple
 * it to every concrete sub-block service signature.
 *
 * Order of checks is load-bearing:
 *   - pending wins over isError (TanStack sets isError true once a
 *     refetch fails, but isPending is true only on the very first
 *     fetch; a refetch failure in a previously-loaded section should
 *     STILL show the prior content surface, not flash to error).
 *   - error wins over empty (a failed refetch that left data=[] is
 *     genuinely a load failure, not "empty by design").
 *   - empty wins over content (caller passes the empty predicate
 *     they care about).
 */
export function subBlockState(
  query: QuerySlice,
  isEmpty: boolean,
): SubBlockState {
  if (query.isPending) {
    return { kind: 'pending' };
  }
  if (query.isError) {
    return { kind: 'error', error: query.error };
  }
  if (isEmpty) {
    return { kind: 'empty' };
  }
  return { kind: 'content' };
}
