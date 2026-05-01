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
 *   /atom/<atom-id>     (generic atom-detail viewer, any atom type)
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

export type Route = 'dashboard' | 'control' | 'live-ops' | 'canon' | 'principals' | 'hierarchy' | 'activities' | 'plans' | 'graph' | 'timeline' | 'plan-lifecycle' | 'canon-suggestions' | 'actor-activity' | 'deliberation' | 'pipelines' | 'atom';

/*
 * `dashboard` is the new home: landing on `/` resolves here so the
 * conference-demo metrics view is the first thing an operator sees.
 * Everything else (control / canon / plans / activities / lifecycle
 * / principals / graph / timeline / canon-suggestions / actor-activity /
 * deliberation)
 * becomes a navigation target from there. Adding dashboard at the
 * head of VALID keeps existing deep-links stable (e.g.
 * `/canon/<atom-id>` still routes to the Canon view).
 */
const DEFAULT: Route = 'dashboard';
const VALID: ReadonlyArray<Route> = [
  'dashboard',
  'control',
  'live-ops',
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
  'deliberation',
  'pipelines',
  'atom',
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

/**
 * Update the URL query string without changing the route or id.
 * Operators get filters that survive a refresh and are shareable as
 * deep links. Pass `null` (or omit a key from the object) to clear
 * that param; an empty string is preserved as `?key=` so a future
 * feature that wants "param present, value blank" can express it.
 * Callers that mean "clear" must pass `null` explicitly. The path is
 * preserved; only `?...` changes.
 *
 * Routing-layer state, not feature-layer state - features that own a
 * filter call this helper instead of localStorage so the URL is the
 * single source of truth.
 */
export function setRouteQuery(updates: Record<string, string | null>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  const next = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
  if (next !== window.location.pathname + window.location.search) {
    window.history.replaceState({}, '', next);
    window.dispatchEvent(new Event(NAV_EVENT));
  }
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
 * Pipeline-descendant atom-id prefixes that belong in the activities
 * feed because they are STREAMING TRANSCRIPT entries (lifecycle events,
 * audit findings, terminal-failure markers, resume points). The
 * activities focus mode is the right home for transcript-shaped data
 * because the operator's mental model is "scroll back through
 * what happened"; each entry is small, self-contained, and ordered.
 *
 * Order matters at the call site: this list is matched BEFORE the
 * generic `pipeline-` branch so a future descendant rename does not
 * silently re-route to /pipelines/<id>.
 */
const PIPELINE_DESCENDANT_ACTIVITY_PREFIXES = [
  'pipeline-stage-event-',
  'pipeline-audit-finding-',
  'pipeline-failed-',
  'pipeline-resume-',
] as const;

/*
 * Pipeline stage-OUTPUT atoms - the brainstorm prose, the spec body,
 * the review report, the dispatch record. These differ from the
 * streaming transcript entries above: each is a first-class atom with
 * a rich type-specific renderer in the atom-detail viewer
 * (apps/console/src/features/atom-detail-viewer/renderers/*.tsx).
 * Routing them to /activities/<id> would land the operator on the
 * activity-feed focus mode where the body collapses to a one-line
 * preview + raw JSON, hiding the dedicated renderer's structured
 * view (open questions, alternatives, audit findings, ...).
 *
 * Per the operator-stated bar "we want to actually be able to see the
 * full atom details when we click on it. basically we want the
 * console to have really really great observability" (2026-05-01),
 * these atoms route to /atom/<id> so the dispatched renderer is
 * what the operator sees.
 */
const PIPELINE_STAGE_OUTPUT_PREFIXES = [
  'brainstorm-output-',
  'spec-output-',
  'review-report-',
  'dispatch-record-',
] as const;

/*
 * Atom-id prefixes that route directly to the activities feed because
 * the atoms ARE activity-shaped (operator-action, actor-messages,
 * audit replies, planner-deliberation questions, intent records).
 */
const ACTIVITY_PREFIXES = [
  'op-action-',
  'ama-',
  'pr-observation-',
  'intent-',
  'q-',
] as const;

/*
 * Atom-id prefixes that signal a canon-shaped atom (L3 directive,
 * decision, preference, reference, invariant, architecture, policy).
 * Routed to the canon viewer's focus mode where filter + drift checks
 * give an L3-aware shell. New canon-domain prefixes go here so they
 * land on the canon page rather than the generic atom-detail viewer.
 */
const CANON_PREFIXES = [
  'arch-',
  'dev-',
  'inv-',
  'pol-',
  'dec-',
  'pref-',
  'ref-',
] as const;

function hasAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/*
 * Given an atom id, pick the view it belongs to. The order is precise:
 *
 *   1. plan-merge-settled-*                -> activities (settlement records)
 *   2. pipeline-stage-event-*, audit-*,
 *      failed-*, resume-*                  -> activities (streaming transcript)
 *   3. brainstorm/spec/review/dispatch-*   -> atom       (rich stage-output renderers)
 *   4. pipeline-*                          -> pipelines  (root pipeline atoms)
 *   5. plan-*                              -> plans      (plan documents)
 *   6. activity prefixes                   -> activities (operator + messaging)
 *   7. canon prefixes                      -> canon      (L3 governance atoms)
 *   8. anything else                       -> atom       (generic detail viewer)
 *
 * The trailing `'atom'` fallback (introduced 2026-05-01) replaces an
 * earlier `return 'canon'` default. The substrate writes atoms of
 * MANY types (plan, pipeline-stage-event, brainstorm-output, spec-output,
 * review-report, dispatch-record, actor-message, agent-session,
 * agent-turn, operator-intent, observation, pr-fix-observation, ...);
 * a canon-default routed every unknown id to the canon viewer's
 * focus-mode, which silently filters non-canon types out of the L3
 * grid and rendered an empty page. The generic atom-detail viewer at
 * `/atom/<id>` handles every atom type via a type-dispatch table with
 * a generic fallback for unknown types.
 *
 * Step 3 (PIPELINE_STAGE_OUTPUT_PREFIXES -> 'atom') was added
 * 2026-05-01 after the audit found stage-output chips on
 * /pipelines/<id> routed to /activities/<id> instead of the new
 * rich renderers; see PIPELINE_STAGE_OUTPUT_PREFIXES JSDoc.
 */
export function routeForAtomId(id: string): Route {
  if (id.startsWith('plan-merge-settled-')) return 'activities';
  if (hasAnyPrefix(id, PIPELINE_DESCENDANT_ACTIVITY_PREFIXES)) return 'activities';
  if (hasAnyPrefix(id, PIPELINE_STAGE_OUTPUT_PREFIXES)) return 'atom';
  if (id.startsWith('pipeline-')) return 'pipelines';
  if (id.startsWith('plan-')) return 'plans';
  if (hasAnyPrefix(id, ACTIVITY_PREFIXES)) return 'activities';
  if (hasAnyPrefix(id, CANON_PREFIXES)) return 'canon';
  return 'atom';
}
