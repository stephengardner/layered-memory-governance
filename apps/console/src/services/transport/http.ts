/**
 * HttpTransport: v1 transport impl that talks to the backend Node
 * server at /api/*. Vite dev proxies /api to the backend port, so in
 * dev AND in a real deployment (same origin) the path stays stable.
 *
 * Method name convention: dotted path maps to URL segment. `atoms.list`
 * -> POST /api/atoms.list (POST so we can carry a JSON body uniformly
 * whether params are present or not). Response is always
 * `{ ok: true, data: T }` on success, `{ ok: false, error: {...} }`
 * on failure; we unwrap here so callers see a typed T or a thrown
 * Error.
 *
 * Subscribe uses Server-Sent Events. Channel `events.atoms` -> GET
 * /api/events/atoms. The EventSource returned is closed by the
 * unsubscribe callback.
 */

import type { Transport, TransportCallOptions } from './types';

interface OkEnvelope<T> {
  readonly ok: true;
  readonly data: T;
}
interface ErrEnvelope {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}
type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export class HttpTransport implements Transport {
  constructor(private readonly basePath: string = '/api') {}

  async call<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: TransportCallOptions,
  ): Promise<T> {
    const url = `${this.basePath}/${method}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`http-${response.status}: ${await response.text().catch(() => '')}`);
    }
    const env = (await response.json()) as Envelope<T>;
    if (!env.ok) {
      const err = new Error(`${env.error.code}: ${env.error.message}`);
      err.name = env.error.code;
      throw err;
    }
    return env.data;
  }

  /*
   * SSE named events MUST be registered explicitly via
   * addEventListener — EventSource.onmessage only fires for messages
   * WITHOUT an `event:` field. The server broadcasts named events
   * (`atom.created`, `atom.deleted`, `atom.changed`, `ping`, `open`)
   * so before this fix the client heard nothing after the initial
   * open and TanStack Query caches never invalidated, leaving the UI
   * staring at stale data.
   *
   * We register the same parsing handler against each broadcast name
   * plus the default `message` channel; the server can evolve its
   * event vocabulary as long as the names it emits are included in
   * SSE_EVENT_NAMES below.
   */
  subscribe<T>(channel: string, onEvent: (ev: T) => void, onError?: (err: Error) => void): () => void {
    const url = `${this.basePath}/events/${channel}`;
    const source = new EventSource(url);
    const handle = (ev: MessageEvent) => {
      try {
        onEvent(JSON.parse(ev.data) as T);
      } catch (err) {
        onError?.(err as Error);
      }
    };
    for (const name of SSE_EVENT_NAMES) {
      source.addEventListener(name, handle as EventListener);
    }
    // Keep `onmessage` wired too so an un-named server emit still
    // reaches the consumer (defensive — the server SHOULD always
    // emit a named event, but we tolerate either shape).
    source.onmessage = handle;
    source.onerror = () => {
      onError?.(new Error(`sse-error on channel ${channel}`));
    };
    return () => {
      for (const name of SSE_EVENT_NAMES) {
        source.removeEventListener(name, handle as EventListener);
      }
      source.close();
    };
  }
}

/*
 * All named SSE events the server emits on /api/events/atoms. If the
 * server adds a new one, add it here.
 */
const SSE_EVENT_NAMES: readonly string[] = [
  'atom.created',
  'atom.changed',
  'atom.deleted',
  'ping',
  'open',
] as const;
