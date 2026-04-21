import { transport } from './transport';

/*
 * Session service — resolves the operator identity the server will
 * attribute UI-originated governance writes to (reinforcements,
 * mark-stales, proposals, kill-switch transitions).
 *
 * Design:
 *   - The identity lives on the server, sourced from the
 *     `LAG_CONSOLE_ACTOR_ID` env var at boot. The server is the
 *     single point of truth because it's the trust boundary — the
 *     client can't be allowed to self-identify (a browser tab could
 *     claim any id). Each deployment configures this explicitly.
 *   - The client reads it via `session.current` and caches with
 *     TanStack Query (staleTime: Infinity — the identity doesn't
 *     change within a running app session).
 *   - When the server returns `actor_id: null` (env var unset), the
 *     client fails closed at mutation time via `requireActorId`.
 *     Per canon `dev-framework-mechanism-only`, a governance write
 *     without a known operator MUST NOT silently proceed.
 *
 * This replaces the hardcoded `'stephen-human'` literal that was
 * baked into CanonCard, ProposeAtomDialog, and KillSwitchPill. That
 * was a canon violation (`dev-framework-mechanism-only`: framework
 * code stays mechanism-only, instance identity lives in config) and
 * a governance integrity bug (every operator's writes got attributed
 * to one specific human).
 */
export async function getCurrentActorId(signal?: AbortSignal): Promise<string | null> {
  const res = await transport.call<{ actor_id: string | null }>(
    'session.current',
    {},
    signal ? { signal } : undefined,
  );
  return res.actor_id;
}

/*
 * Fail-closed helper for mutation callbacks. Use inside mutationFn
 * to convert a "session not configured" state into a loud error
 * rather than silently falling back to a hardcoded id.
 */
export function requireActorId(actorId: string | null | undefined): string {
  if (!actorId) {
    throw new Error(
      'LAG_CONSOLE_ACTOR_ID is not configured on the backend. '
      + 'Set the env var to the principal id the console should attribute writes to and restart `npm run dev:server`.',
    );
  }
  return actorId;
}
