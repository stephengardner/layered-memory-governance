/**
 * verified-citation-set helper contract tests.
 *
 * The helper computes the closure of citations the deep planning
 * pipeline runner forwards into every stage's StageInput. The set is
 * the seed atoms plus the L3 directive canon atoms applicable at the
 * planning principal's scope, excluding tainted and superseded atoms.
 *
 * Tests assert the fence shape: seed atoms always pass through;
 * tainted / superseded / wrong-scope canon atoms never appear; the
 * order of seed atoms is preserved in the output prefix; pagination
 * walks every page rather than only the first.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error -- pure-mjs helper imported from a TS test file.
import { computeVerifiedCitedAtomIds } from '../../scripts/lib/verified-citation-set.mjs';

type AnyAtom = {
  id: string;
  type: string;
  layer: string;
  taint: 'clean' | string;
  superseded_by: ReadonlyArray<string>;
  scope: string;
};

function mkDirective(
  id: string,
  scope: string,
  overrides: Partial<AnyAtom> = {},
): AnyAtom {
  return {
    id,
    type: 'directive',
    layer: 'L3',
    taint: 'clean',
    superseded_by: [],
    scope,
    ...overrides,
  };
}

/**
 * Build a host stub whose atoms.query yields the supplied directive
 * atoms paginated by pageSize. Mirrors the actual host's
 * filter+pagination contract narrowly: filters by type+layer (we
 * pre-filter the supplied list to match) and walks pages of pageSize.
 */
function mkHostStub(directives: ReadonlyArray<AnyAtom>, pageSize = 2) {
  return {
    atoms: {
      query: async (
        filter: { type?: string[]; layer?: string[] },
        limit: number,
        cursor?: string,
      ) => {
        const want = directives.filter(
          (a) =>
            (filter.type === undefined || filter.type.includes(a.type))
            && (filter.layer === undefined || filter.layer.includes(a.layer)),
        );
        const start = cursor ? Number(cursor) : 0;
        const end = Math.min(start + Math.min(limit, pageSize), want.length);
        const atoms = want.slice(start, end);
        const nextCursor = end < want.length ? String(end) : null;
        return { atoms, nextCursor };
      },
    },
  };
}

describe('computeVerifiedCitedAtomIds', () => {
  it('returns the seed atoms when the canon scan yields nothing', async () => {
    const host = mkHostStub([]);
    const result = await computeVerifiedCitedAtomIds(host, {
      seedAtomIds: ['intent-foo', 'intent-bar'],
      scope: 'project',
    });
    expect(result).toEqual(['intent-foo', 'intent-bar']);
  });

  it('includes every applicable clean L3 directive atom past the seed set', async () => {
    const host = mkHostStub([
      mkDirective('dev-canon-one', 'project'),
      mkDirective('dev-canon-two', 'project'),
    ]);
    const result = await computeVerifiedCitedAtomIds(host, {
      seedAtomIds: ['intent-foo'],
      scope: 'project',
    });
    expect(result).toContain('intent-foo');
    expect(result).toContain('dev-canon-one');
    expect(result).toContain('dev-canon-two');
    // Seed atom comes first in the chain so the LLM observes the
    // authorising-root before the canon set.
    expect(result[0]).toBe('intent-foo');
  });

  it('excludes tainted directive atoms', async () => {
    const host = mkHostStub([
      mkDirective('dev-canon-clean', 'project'),
      mkDirective('dev-canon-tainted', 'project', { taint: 'compromised' }),
    ]);
    const result = await computeVerifiedCitedAtomIds(host, {
      seedAtomIds: [],
      scope: 'project',
    });
    expect(result).toContain('dev-canon-clean');
    expect(result).not.toContain('dev-canon-tainted');
  });

  it('excludes superseded directive atoms', async () => {
    const host = mkHostStub([
      mkDirective('dev-canon-current', 'project'),
      mkDirective('dev-canon-old', 'project', {
        superseded_by: ['dev-canon-current'],
      }),
    ]);
    const result = await computeVerifiedCitedAtomIds(host, {
      seedAtomIds: [],
      scope: 'project',
    });
    expect(result).toContain('dev-canon-current');
    expect(result).not.toContain('dev-canon-old');
  });

  it('excludes feature/principal-scoped atoms when ctx is project', async () => {
    const host = mkHostStub([
      mkDirective('dev-canon-project', 'project'),
      mkDirective('dev-canon-other-feature', 'feature:other'),
      mkDirective('dev-canon-principal-scoped', 'principal:other-actor'),
    ]);
    const result = await computeVerifiedCitedAtomIds(host, {
      seedAtomIds: [],
      scope: 'project',
    });
    expect(result).toContain('dev-canon-project');
    expect(result).not.toContain('dev-canon-other-feature');
    expect(result).not.toContain('dev-canon-principal-scoped');
  });

  it('walks every page of the canon scan, not just the first', async () => {
    // 5 directives; pageSize=2 forces three pages. A naive
    // first-page-only implementation would miss `dev-canon-five`.
    const host = mkHostStub(
      [
        mkDirective('dev-canon-one', 'project'),
        mkDirective('dev-canon-two', 'project'),
        mkDirective('dev-canon-three', 'project'),
        mkDirective('dev-canon-four', 'project'),
        mkDirective('dev-canon-five', 'project'),
      ],
      /* pageSize */ 2,
    );
    const result = await computeVerifiedCitedAtomIds(host, {
      seedAtomIds: [],
      scope: 'project',
    });
    expect(result).toContain('dev-canon-one');
    expect(result).toContain('dev-canon-two');
    expect(result).toContain('dev-canon-three');
    expect(result).toContain('dev-canon-four');
    expect(result).toContain('dev-canon-five');
  });

  // CR PR #251 finding: a malformed adapter that returns zero atoms
  // with a non-null nextCursor would spin the pagination loop forever
  // because totalSeen never advances. Guard with an explicit
  // empty-page break.
  it('does not hang when the adapter returns an empty page with a non-null cursor', async () => {
    let calls = 0;
    const host = {
      atoms: {
        query: async (
          _filter: { type?: string[]; layer?: string[] },
          _limit: number,
          _cursor?: string,
        ) => {
          calls += 1;
          // Always return zero atoms but pretend there is more.
          return { atoms: [], nextCursor: 'next-page' };
        },
      },
    };
    const result = await computeVerifiedCitedAtomIds(host, {
      seedAtomIds: ['intent-foo'],
      scope: 'project',
    });
    // Result is just the seed; the canon scan exited on the first
    // empty page rather than looping.
    expect(result).toEqual(['intent-foo']);
    // Bounded call count: the loop must NOT have iterated thousands
    // of times.
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('deduplicates a seed atom that ALSO appears in the canon scan', async () => {
    const host = mkHostStub([mkDirective('dev-canon-one', 'project')]);
    const result = await computeVerifiedCitedAtomIds(host, {
      seedAtomIds: ['dev-canon-one'],
      scope: 'project',
    });
    const occurrences = result.filter((id: string) => id === 'dev-canon-one').length;
    expect(occurrences).toBe(1);
  });
});
