/**
 * Policy primitives for tool-level governance. Two concerns live
 * here, one seam:
 *
 *   - tool-policy.ts loads per-principal tool policy atoms from canon
 *     (the configuration half)
 *   - check.ts evaluates a tool call against a loaded policy
 *     (the decision half)
 *
 * Callers import everything from the policy subpath barrel.
 */
export {
  checkToolPolicy,
  matchSpecificity,
  parsePolicy,
} from './check.js';
export type {
  PolicyContext,
  PolicyDecision,
  PolicyResult,
} from './check.js';

export {
  LLM_TOOL_POLICY_PREFIX,
  LlmToolPolicyError,
  llmToolPolicyAtomId,
  loadLlmToolPolicy,
} from './tool-policy.js';
export type { LlmToolPolicy } from './tool-policy.js';
