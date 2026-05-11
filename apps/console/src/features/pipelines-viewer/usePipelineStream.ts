import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  subscribeToPipelineStream,
  type PipelineStreamAtomChange,
  type PipelineStreamPipelineStateChange,
} from '@/services/pipelines.service';

/**
 * SSE connection-state values surfaced to the UI. Used by the
 * pipeline detail view to switch its TanStack Query refetchInterval
 * (push-driven when the stream is live; polling when it is not) and,
 * optionally, by future telemetry surfaces that want to render a
 * "live" indicator.
 */
export type PipelineStreamConnectionState = 'connecting' | 'open' | 'reconnecting' | 'failed';

export interface UsePipelineStreamOptions {
  /**
   * Maximum reconnect delay in milliseconds. Defaults to 16_000
   * (16s), the spec's documented ceiling on the exponential backoff
   * 1s -> 2s -> 4s -> 8s -> 16s.
   */
  readonly maxReconnectDelayMs?: number;
  /**
   * Number of consecutive failed connection attempts before the hook
   * gives up and reports `failed`. Defaults to 5, which yields a
   * total elapsed time of roughly 31s (1 + 2 + 4 + 8 + 16) of
   * recovery attempts before the fallback poll takes over. The
   * fallback poll is the safety net; we do not want to retry forever
   * because EventSource holds a TCP connection.
   */
  readonly maxReconnectAttempts?: number;
}

const DEFAULT_MAX_RECONNECT_DELAY_MS = 16_000;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Per-pipeline SSE subscription hook for the detail view.
 *
 * On mount it opens an EventSource to /api/events/pipeline.<id> via
 * the transport's subscribe seam. Each `atom-change` event triggers
 * a TanStack Query invalidation for the affected pipeline detail and
 * lifecycle queries, which causes the view to refetch the full
 * projection. `pipeline-state-change` events optionally patch the
 * cached detail in place so the state pill flips without a round-
 * trip.
 *
 * On connection failure the hook backs off exponentially (1s, 2s,
 * 4s, 8s, 16s) and retries up to maxReconnectAttempts times. After
 * that it surfaces `failed`, leaving the detail view's fallback poll
 * to keep the data fresh.
 *
 * useEffect is the right primitive here: per the Console canon
 * "useEffect survives only for real DOM side effects (focus
 * management, observers)", an EventSource is an observer-shaped
 * side effect, not a data fetch. The query-cache invalidation is a
 * push-side write, not a pull.
 */
export function usePipelineStream(
  pipelineId: string,
  options: UsePipelineStreamOptions = {},
): PipelineStreamConnectionState {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<PipelineStreamConnectionState>('connecting');

  /*
   * Mount-stable refs for the option values. Stuffing them through
   * useEffect deps would re-open the EventSource on every render
   * because option object identity changes; the hook's subscribe
   * effect only depends on pipelineId + queryClient by design.
   *
   * The values are read at attempt time, not closed over at mount,
   * so a re-render with new options still picks them up on the next
   * reconnect.
   */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!pipelineId) return undefined;

    let unsubscribe: (() => void) | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setConnectionState(attempt === 0 ? 'connecting' : 'reconnecting');
      try {
        unsubscribe = subscribeToPipelineStream(pipelineId, {
          onOpen: () => {
            attempt = 0;
            setConnectionState('open');
          },
          onAtomChange: (ev: PipelineStreamAtomChange) => {
            /*
             * Invalidate every pipeline-scoped query that reads
             * disk-backed state for this pipeline. Two calls cover
             * all the readers because TanStack Query's
             * invalidateQueries does prefix-matching on the queryKey
             * array by default:
             *
             *   - `['pipeline', pipelineId]`            <- root detail
             *   - `['pipeline', pipelineId, 'lifecycle']`   <- prefix match
             *   - `['pipeline', pipelineId, 'intent-outcome']` <- prefix match
             *   - `['pipeline-error-state', pipelineId]` <- separate root
             *
             * The single `['pipeline', pipelineId]` call fans out to
             * lifecycle + intent-outcome via prefix-match without
             * cancelling-and-restarting each child query individually
             * (default `cancelRefetch: true` means listing every
             * subtree key would restart the same in-flight fetch
             * repeatedly on a high-frequency SSE event). CR PR #404
             * finding.
             *
             * PipelineErrorBlock uses a distinct root (`pipeline-
             * error-state`) so it needs its own invalidate call.
             */
            void queryClient.invalidateQueries({ queryKey: ['pipeline', ev.pipeline_id] });
            void queryClient.invalidateQueries({ queryKey: ['pipeline-error-state', ev.pipeline_id] });
          },
          onPipelineStateChange: (ev: PipelineStreamPipelineStateChange) => {
            /*
             * Light patch on state-change: the operator-visible state
             * pill updates within a frame. The full re-fetch still
             * runs via the atom-change companion event so derived
             * fields (completed_at, duration_ms, etc.) catch up
             * shortly after.
             */
            queryClient.setQueryData(['pipeline', ev.pipeline_id], (prev: unknown) => {
              if (typeof prev !== 'object' || prev === null) return prev;
              const record = prev as { pipeline?: { pipeline_state?: string | null } };
              if (typeof record.pipeline !== 'object' || record.pipeline === null) return prev;
              if (ev.pipeline_state === null) return prev;
              return {
                ...record,
                pipeline: { ...record.pipeline, pipeline_state: ev.pipeline_state },
              };
            });
          },
          onError: () => {
            if (disposed) return;
            unsubscribe?.();
            unsubscribe = null;
            scheduleReconnect();
          },
        });
      } catch {
        // EventSource construction itself failed (e.g. invalid URL,
        // missing global). Treat as a connect failure + reconnect.
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const maxAttempts = optionsRef.current.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
      if (attempt >= maxAttempts) {
        setConnectionState('failed');
        return;
      }
      const cap = optionsRef.current.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
      /*
       * Route through the exported computeReconnectDelayMs helper
       * so the backoff curve has exactly one source of truth (the
       * unit-tested pure function), not a copy here that can drift
       * if the helper grows jitter or other policy.
       */
      const delay = computeReconnectDelayMs(attempt, cap, DEFAULT_INITIAL_RECONNECT_DELAY_MS);
      attempt += 1;
      setConnectionState('reconnecting');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      unsubscribe?.();
      unsubscribe = null;
    };
  }, [pipelineId, queryClient]);

  return connectionState;
}

/**
 * Pure helper: compute the next reconnect delay for a given attempt
 * count, capped at maxDelayMs. Extracted from usePipelineStream so
 * the backoff curve can be unit-tested without touching React or
 * EventSource.
 */
export function computeReconnectDelayMs(
  attempt: number,
  maxDelayMs: number = DEFAULT_MAX_RECONNECT_DELAY_MS,
  initialDelayMs: number = DEFAULT_INITIAL_RECONNECT_DELAY_MS,
): number {
  if (attempt < 0 || !Number.isFinite(attempt)) return initialDelayMs;
  return Math.min(maxDelayMs, initialDelayMs * 2 ** attempt);
}
