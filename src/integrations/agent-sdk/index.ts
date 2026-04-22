/**
 * Agent SDK integration barrel.
 *
 * Re-exports the per-principal agent process and the deliberation
 * coordinator. Downstream code writes
 *   `import { startAgent, deliberate } from 'lag/integrations/agent-sdk'`
 * and never reaches into a specific file.
 */

export * from './agent-process.js';
export * from './checkpoint.js';
export * from './cli-client.js';
export * from './coordinator.js';
