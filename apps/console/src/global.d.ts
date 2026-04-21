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
