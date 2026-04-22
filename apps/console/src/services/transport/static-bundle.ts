/**
 * StaticBundleTransport: demo-mode transport that resolves
 * `call(method, params)` against a pre-baked JSON bundle instead of
 * hitting a backend server. Used for the hosted demo build where
 * there is no `.lag/` directory to read from.
 *
 * Zero-data tolerant: if no bundle is supplied (or a method is
 * missing from the bundle) the transport returns an empty result of
 * the shape the UI expects (empty array for list-shaped methods,
 * null for scalar-shaped methods, empty object for stats). The UI
 * shows its existing empty state; nothing breaks. That lets the
 * skeleton land before the bundle is authored.
 *
 * Filtering contract: list-shaped responses may accept `limit` and
 * simple filter params. The bundle stores the FULL list for each
 * method; this transport applies the filter client-side so one
 * bundle serves every UI variant.
 *
 * Subscribe is a no-op in demo mode. Live SSE streams have no
 * meaning when the data is frozen; the demo is intentionally a
 * point-in-time snapshot of a fictional org. Components that rely
 * on subscribe for real-time updates will simply never receive
 * events; this is desired behavior, not a bug.
 *
 * Selection: `index.ts` picks this transport when
 * `import.meta.env.VITE_LAG_TRANSPORT === 'demo'`. The env var is
 * baked into the build; a demo site and a real-data site are two
 * different artifacts and cannot become confused at runtime.
 */

import type { Transport, TransportCallOptions } from './types';

/**
 * Bundle shape: a dictionary keyed by transport method name. Each
 * value is the full response the backend would have returned for an
 * unparameterized call. Filter / limit params are applied by this
 * transport, not by the bundle author.
 *
 * Unknown methods return sensible empties rather than throw so that
 * a partially-populated demo bundle still renders the whole app;
 * the UI shows empty states for the sections without data.
 */
export type DemoBundle = Readonly<Record<string, unknown>>;

const EMPTY_BUNDLE: DemoBundle = Object.freeze({});

export class StaticBundleTransport implements Transport {
  constructor(private readonly explicitBundle: DemoBundle | undefined = undefined) {}

  /**
   * Resolve the active bundle at call time rather than construction
   * time. The transport singleton (`services/transport/index.ts`)
   * is created when the first service module loads, which is
   * BEFORE `main.tsx` can install `window.__LAG_DEMO_BUNDLE__`.
   * Looking up the bundle per-call keeps install-order independent:
   * as long as the bundle is on `window` by the time the first
   * TanStack Query fires, everything renders.
   */
  private resolvedBundle(): DemoBundle {
    if (this.explicitBundle !== undefined) return this.explicitBundle;
    if (typeof window !== 'undefined' && window.__LAG_DEMO_BUNDLE__ !== undefined) {
      return window.__LAG_DEMO_BUNDLE__;
    }
    return EMPTY_BUNDLE;
  }

  async call<T>(
    method: string,
    params?: Record<string, unknown>,
    _options?: TransportCallOptions,
  ): Promise<T> {
    const raw = this.resolvedBundle()[method];
    if (raw === undefined) {
      return emptyFallbackFor<T>(method);
    }
    return applyParams<T>(raw as T, params);
  }

  /**
   * SSE subscribe has no meaningful demo-mode behavior; returning a
   * no-op unsubscribe keeps the consumer contract intact (every
   * subscribe() call produces a disposer the consumer invokes on
   * unmount). No events ever fire.
   */
  subscribe<T>(_channel: string, _onEvent: (ev: T) => void, _onError?: (err: Error) => void): () => void {
    return () => { /* no-op: demo mode does not stream */ };
  }
}

/**
 * For a method not in the bundle, return an empty value that matches
 * the common response shape rather than throwing. Heuristic: method
 * names ending in `.list` or `.search` expect arrays; `.stats` /
 * `.summary` expect objects; everything else returns null.
 *
 * If a consumer needs a more specific empty shape (e.g. a
 * `stats`-style method that wants zeroed counters rather than `{}`),
 * populate the bundle with the exact default.
 */
function emptyFallbackFor<T>(method: string): T {
  if (method.endsWith('.list') || method.endsWith('.search') || method.endsWith('.recent')) {
    return [] as unknown as T;
  }
  if (method.endsWith('.stats') || method.endsWith('.summary')) {
    return {} as unknown as T;
  }
  return null as unknown as T;
}

/**
 * Apply a minimal subset of param semantics client-side. Keeps the
 * bundle author's job to "list every atom once"; the transport
 * handles per-call filtering.
 *
 * Supported keys:
 *   limit: number   - truncate the front of an array
 *   offset: number  - skip N from the front of an array
 * Anything else passes through untouched. The backend server has
 * richer filter semantics; add them here when a consumer actually
 * needs them for the demo.
 */
function applyParams<T>(value: T, params: Record<string, unknown> | undefined): T {
  if (!params) return value;
  if (!Array.isArray(value)) return value;
  let out: unknown[] = value.slice();
  /*
   * Robust pagination parsing. Reject NaN / Infinity / negative
   * values silently by falling back to the no-op (offset=0, no
   * limit). A naive `typeof === 'number'` check accepts Number.NaN
   * (slice(0, NaN) returns []) and negatives (slice(0, -1) drops
   * the last element), both of which produce surprising UI
   * behaviour the bundle author can't see in review. Floor via
   * Math.trunc so fractional inputs don't double-slice.
   */
  const offsetRaw = params['offset'];
  const limitRaw = params['limit'];
  const offset =
    typeof offsetRaw === 'number' && Number.isFinite(offsetRaw) && offsetRaw > 0
      ? Math.trunc(offsetRaw)
      : 0;
  const limit =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw >= 0
      ? Math.trunc(limitRaw)
      : undefined;
  if (offset > 0) out = out.slice(offset);
  if (limit !== undefined) out = out.slice(0, limit);
  return out as unknown as T;
}
