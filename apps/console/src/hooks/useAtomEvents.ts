import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { transport } from '@/services/transport';

/**
 * Subscribe to the SSE `atoms` channel and invalidate every atom-
 * related TanStack Query key when a new atom lands. Atoms show up
 * in all four list views (canon/plans/activities/graph) so we wipe
 * all four caches together — the next render refetches fresh data.
 *
 * One subscription per app instance (mount this from App root). The
 * transport layer is runtime-neutral; Tauri swap later emits the
 * same event shape via IPC.
 */
export function useAtomEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const unsub = transport.subscribe<{ id: string; at: string }>(
      'atoms',
      (_ev) => {
        qc.invalidateQueries({ queryKey: ['canon'] });
        qc.invalidateQueries({ queryKey: ['plans'] });
        qc.invalidateQueries({ queryKey: ['activities'] });
        qc.invalidateQueries({ queryKey: ['daemon.status'] });
      },
      (err) => {
        console.warn('[atoms-sse]', err.message);
      },
    );
    return unsub;
  }, [qc]);
}
