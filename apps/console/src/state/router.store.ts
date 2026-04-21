import { useSyncExternalStore } from 'react';

/**
 * Minimal HTML5 pathname router. Uses History API for clean URLs
 * (`/canon`, `/principals`, etc.) instead of hash fragments.
 *
 * Exposes route (pathname) + query (?foo=bar) because v1 features
 * want to permalink to "this atom focused" or "this search applied".
 *
 * Design notes:
 *   - Four top-level views is not worth a router dep
 *   - `useSyncExternalStore` + pushState + popstate is ~50 lines and
 *     covers the whole contract we need
 *   - Tauri's webview serves the SPA from a root path; this code
 *     runs identically there
 */

export type Route = 'canon' | 'principals' | 'activities' | 'plans';

const DEFAULT: Route = 'canon';
const VALID: ReadonlyArray<Route> = ['canon', 'principals', 'activities', 'plans'];
const NAV_EVENT = 'lag-console:navigate';

export interface Location {
  readonly route: Route;
  readonly query: URLSearchParams;
}

function parseLocation(pathname: string, search: string): Location {
  const first = pathname.replace(/^\/+/, '').split('/')[0]?.trim() ?? '';
  const route: Route = (VALID as ReadonlyArray<string>).includes(first) ? (first as Route) : DEFAULT;
  const query = new URLSearchParams(search);
  return { route, query };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAV_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAV_EVENT, onChange);
  };
}

const DEFAULT_LOCATION: Location = { route: DEFAULT, query: new URLSearchParams() };

function getSnapshot(): Location {
  if (typeof window === 'undefined') return DEFAULT_LOCATION;
  // Recompute on every snapshot — useSyncExternalStore treats the
  // returned value identity as "did state change". We cache inside
  // a module-level slot so identity is stable between events.
  const loc = parseLocation(window.location.pathname, window.location.search);
  if (
    _cached
    && _cached.route === loc.route
    && _cached.query.toString() === loc.query.toString()
  ) {
    return _cached;
  }
  _cached = loc;
  return loc;
}

let _cached: Location | undefined;

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_LOCATION);
}

export function useRoute(): Route {
  return useLocation().route;
}

export function useRouteQuery(): URLSearchParams {
  return useLocation().query;
}

export function setRoute(next: Route, query?: Record<string, string>): void {
  const qs = query ? toSearchString(query) : '';
  const target = `/${next}${qs}`;
  if (window.location.pathname + window.location.search !== target) {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new Event(NAV_EVENT));
  }
}

export function routeHref(r: Route, query?: Record<string, string>): string {
  return `/${r}${query ? toSearchString(query) : ''}`;
}

function toSearchString(query: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/*
 * Given an atom id, pick the view it belongs to. Canon atoms use
 * domain prefixes (arch/dev/inv/pol), so the default is 'canon'. Only
 * atoms we KNOW live elsewhere get routed away — plans and
 * activity-like atoms (operator-action, actor-messages, audit replies).
 */
export function routeForAtomId(id: string): Route {
  if (id.startsWith('plan-')) return 'plans';
  if (
    id.startsWith('op-action-')
    || id.startsWith('ama-')
    || id.startsWith('pr-observation-')
  ) return 'activities';
  return 'canon';
}
