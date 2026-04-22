// Compatibility shim: moved to src/substrate/arbitration/escalation.ts as part of the
// substrate/runtime/adapters/integrations layer split. Re-exports from the
// new location so existing consumer imports compile unchanged. The shim
// will be removed after consumer imports migrate in a follow-up PR.
export * from '../substrate/arbitration/escalation.js';
