// Pure classifier for the `update-branch-if-stale` CLI.
//
// Extracted into its own module (a) to keep the decision table
// testable without side-effects and (b) so the test file can
// static-import it. The CLI wrapper keeps the shebang and the
// process.exit / spawnSync behavior; this library carries only
// pure state-to-action logic.

/**
 * The GitHub mergeStateStatus enum values the script recognizes:
 *   - BEHIND: head is behind base; merge main into head
 *   - BLOCKED: required checks not satisfied; not our problem here
 *   - CLEAN: ready to merge; no-op
 *   - DIRTY: merge conflicts; human fix required, not our problem
 *   - DRAFT: draft PR; not our problem
 *   - HAS_HOOKS: ready but has post-merge hooks; no-op
 *   - UNKNOWN: GitHub computing; caller should retry
 *   - UNSTABLE: checks failing but mergeable; not our problem
 *
 * Any other value is `unknown` (exit 2) so we never silently assume
 * a stale copy of the enum covers a new state.
 *
 * @param {{ mergeStateStatus?: string } | null | undefined} state
 * @returns {{ kind: 'noop' | 'update' | 'unknown', reason: string }}
 */
export function decideAction(state) {
  const s = state?.mergeStateStatus;
  if (s === 'BEHIND') {
    return { kind: 'update', reason: 'head is BEHIND base; update-branch required' };
  }
  if (s === 'CLEAN' || s === 'HAS_HOOKS') {
    return { kind: 'noop', reason: `state=${s}; already up to date with base` };
  }
  if (s === 'BLOCKED' || s === 'DIRTY' || s === 'DRAFT' || s === 'UNSTABLE') {
    return { kind: 'noop', reason: `state=${s}; not a base-staleness issue` };
  }
  if (s === 'UNKNOWN') {
    return {
      kind: 'noop',
      reason: 'state=UNKNOWN; GitHub still computing mergeability, retry later',
    };
  }
  return { kind: 'unknown', reason: `unrecognized mergeStateStatus=${JSON.stringify(s)}` };
}
