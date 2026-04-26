import { useSyncExternalStore } from 'react';

/**
 * Minimal HTML5 pathname router with two-segment support.
 *
 * Every URL in the app is one of:
 *   /canon
 *   /canon/<atom-id>
 *   /principals
 *   /principals/<principal-id>
 *   /activities
 *   /activities/<atom-id>
 *   /plans
 *   /plans/<plan-id>
 *
 * This is an enterprise-style path structure — the second segment is
 * a first-class URL citizen (permalinkable, bookmarkable, shareable)
 * rather than a `?focus=...` query param dangling off a list view.
 *
 * Why we roll our own instead of pulling react-router:
 *   - Four top-level views + a single slug is not worth a router dep
 *   - `useSyncExternalStore` + pushState + popstate is ~60 lines
 *   - Tauri's webview serves the SPA from a root path; this code runs
 *     identically there
 *
 * For dev + prod static hosts, Vite serves index.html for unknown
 * routes by default, so `/canon/my-atom-id` resolves to the SPA bundle.
 */

export type Route = 'dashboard' | 'control' | 'canon' | 'principals' | 'hierarchy' | 'activities' | 'plans' | 'graph' | 'timeline' | 'plan-lifecycle' | 'canon-suggestions' | 'actor-activity';

/*
 * `dashboard` is the new home: landing on `/` resolves here so the
 * conference-demo metrics view is the first thing an operator sees.
 * Everything else (control / canon / plans / activities / lifecycle
 * / principals / graph / timeline / canon-suggestions / actor-activity)
 * becomes a navigation target from there. Adding dashboard at the
 * head of VALID keeps existing deep-links stable (e.g.
 * `/canon/<atom-id>` still routes to the Canon view).
 */
const DEFAULT: Route = 'dashboard';
const VALID: ReadonlyArray<Route> = [
  'dashboard',
  'control',
  'canon',
  'principals',
  'hierarchy',
  'activities',
  'plans',
  'graph',
  'timeline',
  'plan-lifecycle',
  'canon-suggestions',
  'actor-activity',
];
const NAV_EVENT = 'lag-console:navigate';

export interface Location {
  readonly route: Route;
  /** The second path segment (atom / plan / principal id) if present. */
  readonly id: string | null;
  readonly query: URLSearchParams;
}

function parseLocation(pathname: string, search: string): Location {
  const segs = pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  const first = segs[0]?.trim() ?? '';
  const route: Route = (VALID as ReadonlyArray<string>).includes(first) ? (first as Route) : DEFAULT;
  const rawId = segs[1]?.trim();
  const id = rawId ? decodeURIComponent(rawId) : null;
  const query = new URLSearchParams(search);
  return { route, id, query };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAV_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAV_EVENT, onChange);
  };
}

const DEFAULT_LOCATION: Location = { route: DEFAULT, id: null, query: new URLSearchParams() };
let _cached: Location | undefined;

function getSnapshot(): Location {
  if (typeof window === 'undefined') return DEFAULT_LOCATION;
  const loc = parseLocation(window.location.pathname, window.location.search);
  if (
    _cached
    && _cached.route === loc.route
    && _cached.id === loc.id
    && _cached.query.toString() === loc.query.toString()
  ) {
    return _cached;
  }
  _cached = loc;
  return loc;
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_LOCATION);
}

export function useRoute(): Route {
  return useLocation().route;
}

export function useRouteId(): string | null {
  return useLocation().id;
}

export function useRouteQuery(): URLSearchParams {
  return useLocation().query;
}

export function setRoute(next: Route, id?: string): void {
  const target = id ? `/${next}/${encodeURIComponent(id)}` : `/${next}`;
  if (window.location.pathname !== target) {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new Event(NAV_EVENT));
    /*
     * Programmatic navigation scrolls to top — standard SPA pattern.
     * Back/forward triggers popstate (NOT NAV_EVENT), and the browser
     * auto-restores scroll via history.scrollRestoration='auto' (default),
     * so the user lands where they were. One window handles both cases
     * without a custom scroll cache.
     */
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    /*
     * The app shell's .content element is the actual scrollable area
     * (the page body doesn't scroll — overflow-y is on the main),
     * so reset it too. querySelector is safe because AppShell is
     * always mounted by the time anyone calls setRoute.
     */
    const scroller = document.querySelector<HTMLElement>('[data-scroll-root]');
    if (scroller) scroller.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }
}

export function routeHref(r: Route, id?: string): string {
  return id ? `/${r}/${encodeURIComponent(id)}` : `/${r}`;
}

/*
 * Given an atom id, pick the view it belongs to. Canon atoms use
 * domain prefixes (arch/dev/inv/pol), so the default is 'canon'. Only
 * atoms we KNOW live elsewhere get routed away — plans and
 * activity-like atoms (operator-action, actor-messages, audit replies).
 *
 * `plan-merge-settled-*` atoms are settlement records emitted by
 * pr-landing-agent; they're activity-shaped, not plan documents, so
 * route them with the other activity atoms. The check is order-
 * sensitive — must precede the generic `plan-` prefix.
 */
export function routeForAtomId(id: string): Route {
  if (id.startsWith('plan-merge-settled-')) return 'activities';
  if (id.startsWith('plan-')) return 'plans';
  if (
    id.startsWith('op-action-')
    || id.startsWith('ama-')
    || id.startsWith('pr-observation-')
    || id.startsWith('intent-')
  ) return 'activities';
  return 'canon';
}
