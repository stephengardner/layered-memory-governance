/**
 * Substrate barrel.
 *
 * Re-exports substrate modules as named namespaces so downstream code
 * (including the future `integrations/` layer) can write
 * `import { deliberation } from '../substrate'` instead of reaching
 * into a specific file. Legacy shim dirs at `src/<module>/` remain in
 * place during the rebuild transition; this barrel does not claim to
 * replace them yet.
 */

export * as deliberation from './deliberation/index.js';
export * as arbitration from './arbitration/index.js';
export * as canonMd from './canon-md/index.js';
export * as killSwitch from './kill-switch/index.js';
export * as promotion from './promotion/index.js';
export * as taint from './taint/index.js';

// Agentic actor loop seams. camelCase namespace names match the
// existing barrel style (canonMd, killSwitch); no snake_case.
export * as agentLoop from './agent-loop.js';
export * as workspaceProvider from './workspace-provider.js';
export * as blobStore from './blob-store.js';
export * as redactor from './redactor.js';
export * as agentBudget from './agent-budget.js';
export * as policyReplayTier from './policy/replay-tier.js';
export * as policyBlobThreshold from './policy/blob-threshold.js';
export * as projectionsSessionTree from './projections/session-tree.js';

export type * from './types.js';
export type * from './interface.js';
export * from './errors.js';
