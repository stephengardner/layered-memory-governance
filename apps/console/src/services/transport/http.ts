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

  subscribe<T>(channel: string, onEvent: (ev: T) => void, onError?: (err: Error) => void): () => void {
    const url = `${this.basePath}/events/${channel}`;
    const source = new EventSource(url);
    source.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data) as T);
      } catch (err) {
        onError?.(err as Error);
      }
    };
    source.onerror = () => {
      onError?.(new Error(`sse-error on channel ${channel}`));
    };
    return () => source.close();
  }
}
