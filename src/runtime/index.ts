/**
 * Runtime - reference orchestration primitives that LAG ships.
 *
 * LoopRunner (decay + TTL tick), executePlan (intent governance),
 * askQuestion (HIL binding), runExtractionPass (L0 to L1 claims via
 * LLM judge), runActor + SubActorRegistry (the actor runtime), the
 * actor-message inbox primitive, and the Daemon ambient runtime -
 * all native LAG orchestration choices that embody substrate-
 * adjacent design (convergence guards, budget enforcement, inbox-
 * as-atoms).
 *
 * External orchestrators (LangGraph, Temporal, etc.) live under
 * src/integrations/ and are peers to this runtime, not dependents.
 * A deployment using LangGraph should not need to import from here.
 */

export * from './loop/index.js';
export * from './plans/index.js';
export * from './questions/index.js';
export * from './claims-extraction/index.js';
export * from './actors/index.js';
export * from './actor-message/index.js';
export * from './daemon/index.js';
