import { transport } from './transport';

/*
 * Actor activity stream service. Mirrors the wire shape from
 * server/actor-activity.ts; we duplicate the type definitions on the
 * client side rather than reaching across to the server module
 * because the runtime + tooling boundaries (vite vs tsx) are kept
 * separate per the transport-abstraction principle.
 *
 * The service shape is forward-compatible with SSE: the server already
 * carries `.stream` in the path, and a future StreamingTransport can
 * upgrade the call without the consumer changing shape.
 */

export interface ActorActivityEntry {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly principal_id: string;
  readonly created_at: string;
  readonly verb: string;
  readonly excerpt: string;
}

export interface ActorActivityGroup {
  readonly key: string;
  readonly principal_id: string;
  readonly entries: ReadonlyArray<ActorActivityEntry>;
  readonly latest_at: string;
}

export interface ActorActivityResponse {
  readonly groups: ReadonlyArray<ActorActivityGroup>;
  readonly entry_count: number;
  readonly principal_count: number;
  readonly generated_at: string;
}

export interface ListActorActivityParams {
  readonly limit?: number;
}

export async function fetchActorActivity(
  params?: ListActorActivityParams,
  signal?: AbortSignal,
): Promise<ActorActivityResponse> {
  return transport.call<ActorActivityResponse>(
    'actor-activity.stream',
    params as Record<string, unknown> | undefined,
    signal ? { signal } : undefined,
  );
}
