/// <reference types="vite/client" />

// Vite env vars we set at build time. VITE_LAG_TRANSPORT selects
// which Transport implementation the singleton in
// src/services/transport/index.ts returns: 'demo' points at the
// StaticBundleTransport (hosted demo / gh-pages build), anything
// else (unset in local dev, or explicitly 'http') uses HttpTransport.
interface ImportMetaEnv {
  readonly VITE_LAG_TRANSPORT?: 'demo' | 'http';
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Window globals that the demo build installs before React mounts.
interface Window {
  __LAG_DEMO_BUNDLE__?: Readonly<Record<string, unknown>>;
}

// CSS Modules: every import `styles from './X.module.css'` resolves
// to a read-only record of class-name strings at build time.
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// Image assets: Vite resolves static imports to a URL string at build.
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.webp' {
  const src: string;
  export default src;
}
