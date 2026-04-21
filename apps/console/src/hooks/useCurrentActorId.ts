import { useQuery } from '@tanstack/react-query';
import { getCurrentActorId } from '@/services/session.service';

/*
 * React binding over the session service. Exposes the server-
 * resolved actor id or null (when LAG_CONSOLE_ACTOR_ID isn't set).
 *
 * staleTime: Infinity — the operator identity is a server-boot
 * config; restarting the backend is the only thing that can change
 * it, and a backend restart tears down the client too.
 *
 * Components that perform writes must call `requireActorId(hookResult)`
 * inside their mutationFn so an unset identity throws loudly
 * instead of silently proceeding with a fallback.
 */
export function useCurrentActorId(): string | null | undefined {
  const q = useQuery({
    queryKey: ['session', 'actor'],
    queryFn: ({ signal }) => getCurrentActorId(signal),
    staleTime: Infinity,
  });
  return q.data;
}
