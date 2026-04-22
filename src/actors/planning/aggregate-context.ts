// Compatibility shim: moved to src/runtime/actors/planning/aggregate-context.ts as
// part of the substrate/runtime/adapters/integrations layer split. Re-exports
// from the new location so existing consumer imports compile unchanged. The
// shim will be removed after consumer imports migrate in a follow-up PR.
export * from '../../runtime/actors/planning/aggregate-context.js';
