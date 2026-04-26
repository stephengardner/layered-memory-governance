/*
 * Pure security helpers extracted from server/index.ts so they can
 * be unit-tested without standing up the full HTTP server.
 *
 * Everything here is:
 *   - Pure: no I/O, no env reads at import time, no side effects.
 *   - Deterministic: identical inputs → identical outputs.
 *
 * If you add new validation logic, put it here so there's one place
 * to reason about the server's input-sanitization surface and so
 * tests can cover it directly.
 */

/*
 * Allowed origins for same-app browser traffic. In dev the frontend
 * runs on DASHBOARD_PORT (9080) and is proxied through vite; in
 * prod both originate from the same hostname. We also include the
 * backend port itself for curl-style local probing.
 *
 * Additional origins can be added at deploy time via
 * `LAG_CONSOLE_ALLOWED_ORIGINS` (comma-separated). Consumers
 * construct the set via `makeAllowedOriginSet` which merges
 * defaults + env extras.
 */
export const DEFAULT_ALLOWED_ORIGINS: ReadonlyArray<string> = [
  'http://localhost:9080',
  'http://127.0.0.1:9080',
  'http://localhost:9081',
  'http://127.0.0.1:9081',
];

export function makeAllowedOriginSet(extra: string | undefined): Set<string> {
  const extras = (extra ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set<string>([...DEFAULT_ALLOWED_ORIGINS, ...extras]);
}

/*
 * Policy for CORS + state-changing-request gating:
 *
 *   - Undefined/missing Origin → "no origin" bucket; callers treat as
 *     same-origin/native/curl/tests and allow.
 *   - Origin in the allowed set → return true, callers reflect in
 *     Access-Control-Allow-Origin.
 *   - Origin present but unknown → return false; callers reject
 *     state-changing requests with 403 and omit ACAO so preflight
 *     fails too.
 */
export function isAllowedOrigin(allowed: ReadonlySet<string>, origin: string | undefined): boolean {
  if (!origin) return true;
  return allowed.has(origin);
}

/*
 * Derive a safe on-disk filename from a request-supplied atom id.
 *
 * Defense against path-traversal: an id such as `../principals/root`
 * would otherwise escape the atoms directory when passed to
 * join(ATOMS_DIR, `${id}.json`) and mutate arbitrary JSON on the
 * operator's filesystem. Only ids matching the atom-id naming
 * convention (alnum start, alnum/dot/dash/underscore body) are
 * accepted; anything else throws `invalid-atom-id` which the route
 * layer maps to a 400.
 *
 * This regex is intentionally stricter than "reject `..` and `/`"
 * because a broader accept set means more surface for encoding
 * tricks (url-encoded slashes, null bytes, windows drive letters).
 */
/*
 * Decide whether the console may serve write-shaped routes (currently
 * `/api/atoms.propose`). The console is read-only by contract per
 * apps/console/CLAUDE.md "Scope boundaries"; opt-in writes require an
 * explicit `LAG_CONSOLE_ALLOW_WRITES=1` env var.
 *
 * Strict equality with `'1'` rather than truthiness: `'0'`, `'false'`,
 * `'no'`, `''` and `undefined` all stay disabled. Future opt-in values
 * can be added here without callers learning new shapes.
 *
 * Pure helper: takes the raw env value, returns a boolean. The env
 * read itself happens at the call site so tests can pass any value
 * directly without process.env mutation.
 */
export function isConsoleWritesAllowed(envValue: string | undefined): boolean {
  return envValue === '1';
}

export function atomFilenameFromId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    const err = Object.assign(new Error(`invalid atom id: ${id}`), { code: 'invalid-atom-id' });
    throw err;
  }
  return `${id}.json`;
}
