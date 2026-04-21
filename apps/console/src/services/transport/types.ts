/**
 * Transport: the single seam between UI code and wherever data
 * actually lives. v1 implementation is HTTP (backend server reads
 * .lag/). v2 (Tauri) swaps for an invoke-based transport; zero
 * component code changes.
 *
 * Every service in this app calls `transport.call(...)` for
 * request/response and `transport.subscribe(...)` for event streams.
 * Direct `fetch()` outside this subtree is banned by eslint.
 */

export interface TransportCallOptions {
  /** Abort signal propagates cancellation (e.g., query cancellation). */
  readonly signal?: AbortSignal;
}

export interface Transport {
  /**
   * Request/response. `method` is a dotted identifier resolvable by
   * whichever backend impl is active (HTTP impl maps dots to URL
   * segments; Tauri impl passes through to a Rust command handler of
   * the same name).
   */
  call<T>(method: string, params?: Record<string, unknown>, options?: TransportCallOptions): Promise<T>;

  /**
   * Subscribe to an event stream on `channel`. Returns an unsubscribe
   * function the caller MUST invoke on component unmount / query
   * cancellation to avoid leaks.
   */
  subscribe<T>(channel: string, onEvent: (ev: T) => void, onError?: (err: Error) => void): () => void;
}
