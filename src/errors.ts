// Compatibility shim: the typed error hierarchy has moved to src/substrate/errors.ts
// so the substrate/runtime/adapters/integrations layering can be expressed
// physically. This file re-exports the same symbols from the new location
// so existing consumers compile without import-path updates. The shim will
// be removed after consumer imports migrate in a follow-up PR.
export * from './substrate/errors.js';
