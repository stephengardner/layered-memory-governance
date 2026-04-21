import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { GraphService, type GraphAtom, type GraphSnapshot, type GraphServiceOptions } from './GraphService';

/*
 * React binding for GraphService. Keeps a single long-lived service
 * instance in a ref, syncs atoms into it on every input change, and
 * exposes the snapshot via useSyncExternalStore.
 *
 * Key properties this guarantees:
 *   - The service instance survives React re-renders. Parent state
 *     changes don't recreate the service; simulation positions
 *     persist.
 *   - setAtoms() runs in useLayoutEffect (NOT useEffect) so the
 *     service's first-pass synchronous settle happens BEFORE the
 *     browser paints the initial graph. Without this the first
 *     paint showed drifting nodes with no bounds, and the auto-fit
 *     deferred into a second frame — the "not fit on load" flash.
 *   - setAtoms() short-circuits when the input signature is
 *     unchanged, so unrelated parent re-renders (TimeAgo, SSE
 *     invalidates of non-graph data) don't restart the sim.
 *   - Snapshot identity is stable between version bumps, which is
 *     what makes useSyncExternalStore work without tearing.
 *   - rAF-driven ticks ONLY run while the sim is unsettled. Once
 *     alpha drops below threshold we stop polling — no forever
 *     30fps render loop.
 */
export function useGraphService(
  atoms: ReadonlyArray<GraphAtom>,
  opts: GraphServiceOptions = {},
): {
  readonly snapshot: GraphSnapshot;
  readonly service: GraphService;
} {
  const serviceRef = useRef<GraphService | null>(null);
  if (serviceRef.current === null) {
    serviceRef.current = new GraphService(opts);
    /*
     * Seed atoms during the very first render so the first snapshot
     * is already populated and settled (the service pre-settles on
     * its first non-empty rebuild). Without this seed, the first
     * render reads an empty snapshot and we paint a blank graph
     * before the useLayoutEffect below fills it in. Subsequent
     * renders are handled by the layout effect.
     */
    if (atoms.length > 0) serviceRef.current.setAtoms(atoms);
  }
  const service = serviceRef.current;

  // Sync atoms into the service before paint on every render where
  // the input changed. setAtoms is signature-idempotent so this is
  // cheap on unrelated re-renders.
  useLayoutEffect(() => {
    service.setAtoms(atoms);
  }, [service, atoms]);

  /*
   * Drive ticks via rAF while the sim is unsettled. Skip scheduling
   * entirely when the snapshot is already settled — a mere version
   * bump from select()/toggleKind()/etc. should not kick off a
   * wasted frame that calls tick() (which also needs to no-op when
   * settled, see GraphService.tick). The effect re-fires on every
   * version change so that genuine re-sims (new atoms, filter
   * rebuild) restart the animation.
   */
  useEffect(() => {
    if (service.getSnapshot().settled) return;
    let raf = 0;
    let running = true;
    const loop = () => {
      if (!running) return;
      const active = service.tick();
      if (!active) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, service.getSnapshot().version]);

  // Unmount cleanup: stop the sim, drop listeners implicitly.
  useEffect(() => () => service.stop(), [service]);

  const snapshot = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getSnapshot(),
    () => service.getSnapshot(),
  );

  return { snapshot, service };
}
