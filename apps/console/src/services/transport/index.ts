/**
 * Transport boot-time selection. The ONE file that knows the
 * runtime. Components + features never import from a concrete
 * transport; they import the exported `transport` singleton.
 *
 * v1 (browser + Node dev): HttpTransport talking to the local
 * backend server.
 *
 * v2 (Tauri, future): add a TauriTransport impl that uses
 * `@tauri-apps/api/core`'s invoke + event APIs. Runtime detection
 * will look for `'__TAURI__' in window` and swap here; zero other
 * file changes needed.
 */

import { HttpTransport } from './http';
import type { Transport } from './types';

function selectTransport(): Transport {
  // Future: if ('__TAURI__' in globalThis) return new TauriTransport();
  return new HttpTransport();
}

export const transport: Transport = selectTransport();

export type { Transport } from './types';
