import { describe, it, expect } from 'vitest';
import { subBlockState } from './subBlockState';

/*
 * subBlockState is the load-bearing piece of the sub-block render
 * decision; the JSX in each callsite is a thin switch over the tagged
 * union the helper returns. Testing the helper in isolation keeps the
 * unit suite environment-agnostic (vitest config is `environment:
 * 'node'`, so a render-based test would need jsdom + a host setup
 * that no other unit test in this tree pays for) while still pinning
 * the contract that drives the four observable behaviors.
 */

describe('subBlockState', () => {
  it('returns pending tag while the query is pending', () => {
    const result = subBlockState(
      { isPending: true, isError: false, error: null },
      false,
    );
    expect(result).toEqual({ kind: 'pending' });
  });

  it('returns pending tag even when isEmpty is true (pending wins over empty)', () => {
    /*
     * On the very first fetch TanStack sets isPending=true and the
     * caller's isEmpty predicate computed against `data ?? []` would
     * also evaluate true. The parent surface is already showing a
     * top-level loading state -- a sub-block must NOT flash to "empty"
     * before the first fetch resolves.
     */
    const result = subBlockState(
      { isPending: true, isError: false, error: null },
      true,
    );
    expect(result).toEqual({ kind: 'pending' });
  });

  it('returns error tag with the underlying error when isError is true', () => {
    const err = new Error('500 server error');
    const result = subBlockState(
      { isPending: false, isError: true, error: err },
      false,
    );
    expect(result).toEqual({ kind: 'error', error: err });
  });

  it('returns error tag even when isEmpty is true (error wins over empty)', () => {
    /*
     * A failed refetch that left data=[] is a load failure, not
     * "empty by design". Without this rule a backend outage on an
     * always-empty endpoint would silently render as "no data" and
     * the operator would never see the failure.
     */
    const err = new Error('network');
    const result = subBlockState(
      { isPending: false, isError: true, error: err },
      true,
    );
    expect(result).toEqual({ kind: 'error', error: err });
  });

  it('preserves non-Error rejection values verbatim on the error tag', () => {
    /*
     * The InlineError caller funnels `error` through `toErrorMessage`,
     * which handles strings, nulls, objects, etc. The helper itself
     * stays type-agnostic so a future caller that wants the raw
     * rejection value (for retry diagnostics, for example) is not
     * forced through the lossy String() coercion.
     */
    const result = subBlockState(
      { isPending: false, isError: true, error: 'plain rejection' },
      false,
    );
    expect(result).toEqual({ kind: 'error', error: 'plain rejection' });
  });

  it('returns empty tag when the query resolved with no items', () => {
    const result = subBlockState(
      { isPending: false, isError: false, error: null },
      true,
    );
    expect(result).toEqual({ kind: 'empty' });
  });

  it('returns content tag when the query resolved with items', () => {
    const result = subBlockState(
      { isPending: false, isError: false, error: null },
      false,
    );
    expect(result).toEqual({ kind: 'content' });
  });

  it('does not coerce undefined error to anything else', () => {
    /*
     * Belt-and-suspenders: if a TanStack version ever emits
     * isError=true with error=undefined the helper still produces a
     * stable shape so the caller's `toErrorMessage` doesn't need to
     * branch on undefined-vs-missing.
     */
    const result = subBlockState(
      { isPending: false, isError: true, error: undefined },
      false,
    );
    expect(result).toEqual({ kind: 'error', error: undefined });
  });
});
