/**
 * Substrate - the always-on governance layer.
 *
 * Everything exported here is load-bearing for any LAG deployment,
 * regardless of orchestration strategy. A consumer using LAG as a
 * pure memory store, or wrapping a LangGraph node with LAG policy
 * + kill-switch, uses only what is exported from this barrel.
 *
 * Runtime primitives (LoopRunner, runActor, the reference actors),
 * adapters (memory/file/bridge Host impls), and integrations
 * (LangGraph/Temporal wrappers) live on their own subpaths and are
 * composed on top of the substrate.
 */

// Core types + interfaces + errors
export type * from './types.js';
export type * from './interface.js';
export * from './errors.js';

// Substrate modules
export * from './arbitration/index.js';
export * from './promotion/index.js';
export * from './taint/index.js';
export * from './canon/index.js';
export * from './kill-switch/index.js';
export * from './policy/index.js';
