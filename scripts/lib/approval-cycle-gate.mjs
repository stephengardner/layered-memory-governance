// Pure helpers for scripts/run-approval-cycle.mjs LLM-adapter
// gating. Extracted into a shebang-free module so the test can
// static-import without triggering the script's CLI side effects,
// mirroring the pattern landed for git-as-push-auth.mjs and
// update-branch-decider.mjs.

/**
 * Sub-actor principal ids whose dispatch path includes a step that
 * calls `host.llm.judge` (or otherwise expects a real LLM). When the
 * approval-cycle is started with `--llm=memory` (the deterministic
 * test stub) and the registry contains any of these ids, the daemon
 * must refuse to start instead of failing later inside the executor
 * with an opaque `MemoryLLM has no registered response for key
 * <hash>` error.
 *
 * Exported so tests can pin the set.
 */
export const LLM_REQUIRING_SUB_ACTORS = Object.freeze([
  'code-author',
]);

/**
 * Decide whether the configured LLM adapter is compatible with the
 * registered sub-actor set. Returns null when the configuration is
 * acceptable; returns a typed object with the offenders + a single
 * actionable error message when the gate trips.
 *
 * Pure: no I/O, no globals; same input -> same output.
 */
export function checkLlmCompatibility({ llm, registeredIds }) {
  if (llm !== 'memory') return null;
  const offenders = LLM_REQUIRING_SUB_ACTORS.filter((id) => registeredIds.includes(id));
  if (offenders.length === 0) return null;
  return {
    offenders,
    message:
      `--llm=memory is incompatible with registered sub-actor(s) [${offenders.join(', ')}] `
      + 'whose execution path calls host.llm. Re-run with --llm=claude-cli (default) '
      + 'or remove the offending invoker registration.',
  };
}
