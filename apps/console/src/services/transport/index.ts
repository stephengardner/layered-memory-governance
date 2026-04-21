/**
 * Transport boot-time selection. The ONE file that knows the
 * runtime. Components + features never import from a concrete
 * transport; they import the exported `transport` singleton.
 *
 * v1 (browser + Node dev): HttpTransport talking to the local
 * backend server.
 *
 * v1.5 (hosted demo): StaticBundleTransport resolving calls against
 * a pre-baked JSON bundle. Selected by setting
 * `VITE_LAG_TRANSPORT=demo` at build time; the demo entrypoint
 * populates `window.__LAG_DEMO_BUNDLE__` before React mounts.
 *
 * v2 (Tauri, future): add a TauriTransport impl that uses
 * `@tauri-apps/api/core`'s invoke + event APIs. Runtime detection
 * will look for `'__TAURI__' in window` and swap here; zero other
 * file changes needed.
 */

import { HttpTransport } from './http';
import { StaticBundleTransport, type DemoBundle } from './static-bundle';
import type { Transport } from './types';

declare global {
  interface Window {
    /**
     * Set by the demo-build entrypoint BEFORE React mounts so the
     * StaticBundleTransport has data by the time the first query
     * fires. Undefined in non-demo builds.
     */
    __LAG_DEMO_BUNDLE__?: DemoBundle;
  }
}

function selectTransport(): Transport {
  // Future: if ('__TAURI__' in globalThis) return new TauriTransport();
  if (import.meta.env.VITE_LAG_TRANSPORT === 'demo') {
    // No explicit bundle here - StaticBundleTransport resolves
    // `window.__LAG_DEMO_BUNDLE__` at call time so main.tsx can
    // install the bundle without caring about import order.
    return new StaticBundleTransport();
  }
  return new HttpTransport();
}

export const transport: Transport = selectTransport();

export type { Transport } from './types';
export { StaticBundleTransport } from './static-bundle';
export type { DemoBundle } from './static-bundle';
