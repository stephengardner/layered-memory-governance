/**
 * Deliberation primitives.
 *
 * Pattern-only substrate module: atom shapes (Question, Position,
 * Counter, Decision, Escalation) + shape validators + an arbitrator
 * that calls the existing source-rank primitive + an escalation
 * emitter. This module has no runtime; the coordinator that drives
 * these patterns over a specific agent runtime lives in
 * `src/integrations/<runtime>/`. A second integration (e.g. LangGraph)
 * can drive the same pattern without changes here.
 */

export * from './patterns.js';
export * from './arbitrator.js';
export * from './escalation.js';
