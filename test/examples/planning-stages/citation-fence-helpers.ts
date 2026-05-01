/**
 * Shared test helpers for the citation-fence prompt contract.
 *
 * Consolidated here per the duplication-floor canon: spec-stage and
 * plan-stage tests both assert (a) HARD-CONSTRAINT prompt-text
 * markers and (b) that runStage forwards verifiedCitedAtomIds into
 * the LLM's data block under the `verified_cited_atom_ids` key. A
 * future stage that adopts the same fence imports these helpers
 * rather than copy-pasting the assertions, so a contract change lands
 * in one file rather than four.
 */

import { expect } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { AtomId, PrincipalId } from '../../../src/types.js';
import type {
  PlanningStage,
  StageInput,
} from '../../../src/runtime/planning-pipeline/types.js';

/**
 * Assert a stage's exported system prompt carries the four
 * load-bearing markers of the citation-grounding fence:
 *
 *   1. references the data field name `verified_cited_atom_ids`
 *   2. uses the literal "HARD CONSTRAINT" wording
 *   3. instructs the LLM to "OMIT the citation rather than guess"
 *   4. warns the LLM that an out-of-set citation halts the stage
 *
 * Call sites pass the imported prompt constant; a regression in any
 * of the four shapes is a single-test failure with the file/line
 * traced back to the call site, not buried in a copy of the helper.
 */
export function expectCitationFencePrompt(prompt: string): void {
  expect(prompt).toMatch(/verified_cited_atom_ids/);
  expect(prompt).toMatch(/HARD CONSTRAINT/);
  // The "OMIT the citation\nrather than guess" wording wraps over a
  // line break in PROMPT constants so the regex tolerates any
  // whitespace (including \n) between the two halves.
  expect(prompt).toMatch(/OMIT the citation\s+rather than guess/i);
  expect(prompt).toMatch(/critical audit finding|halts the stage/i);
}

/**
 * Capture host.llm.judge invocations on a stage.run() call and
 * return the captured (system, data) pair the assertions check.
 *
 * Stub LLM returns the supplied stub output verbatim; the test only
 * cares about the data block forwarded into the LLM call, not the
 * LLM's reply.
 */
export async function captureStageRunPrompt<TIn, TOut>(args: {
  readonly stage: PlanningStage<TIn, TOut>;
  readonly stubOutput: TOut;
  readonly stageInput: StageInput<TIn>;
}): Promise<{ system: string; data: Record<string, unknown> } | null> {
  let captured: { system: string; data: Record<string, unknown> } | null = null;
  // Reach into the host's llm.judge slot to capture the call. Tests
  // construct the host via createMemoryHost; this helper does not
  // re-construct it because the StageInput already carries the host.
  const host = args.stageInput.host as ReturnType<typeof createMemoryHost>;
  host.llm.judge = (async (
    _schema: unknown,
    system: unknown,
    data: unknown,
    _options: unknown,
  ) => {
    captured = {
      system: system as string,
      data: data as Record<string, unknown>,
    };
    return {
      output: args.stubOutput,
      metadata: { latency_ms: 1, cost_usd: 0 },
    };
  }) as typeof host.llm.judge;
  await args.stage.run(args.stageInput);
  return captured;
}

/**
 * Assert the runStage forwarded a verified-cited-atom-ids array
 * matching the supplied set into the LLM data block under the
 * stable `verified_cited_atom_ids` key, and that the system prompt
 * references the same key by name (so a downstream prompt-edit
 * reviewer sees the contract wired end-to-end).
 *
 * Throws via expect when the captured pair is null (the test caught
 * a stage that did not call host.llm.judge at all).
 */
export function expectVerifiedCitedAtomIdsForwarded(
  captured: { system: string; data: Record<string, unknown> } | null,
  verifiedIds: ReadonlyArray<AtomId>,
): void {
  expect(captured).not.toBeNull();
  if (captured === null) return;
  expect(Array.isArray(captured.data.verified_cited_atom_ids)).toBe(true);
  expect(captured.data.verified_cited_atom_ids).toEqual(
    verifiedIds.map(String),
  );
  // The system prompt MUST reference the data field by exact name
  // so a downstream prompt-edit reviewer can see the contract
  // wired end-to-end.
  expect(captured.system).toMatch(/verified_cited_atom_ids/);
}

/**
 * Build a minimal StageInput literal for citation-fence prompt
 * contract tests. Each call site passes the principal id and the
 * verified-cited-atom-ids set; everything else is a fixed test
 * default. The verified-sub-actor set defaults to empty when not
 * supplied so the citation-fence-only tests do not need to know
 * about the delegation fence; tests that exercise the delegation
 * fence pass `verifiedSubActorPrincipalIds` explicitly.
 */
export function mkPromptContractStageInput<TIn>(args: {
  readonly host: ReturnType<typeof createMemoryHost>;
  readonly principal: string;
  readonly priorOutput: TIn;
  readonly verifiedCitedAtomIds: ReadonlyArray<AtomId>;
  readonly verifiedSubActorPrincipalIds?: ReadonlyArray<PrincipalId>;
}): StageInput<TIn> {
  return {
    host: args.host,
    principal: args.principal as PrincipalId,
    correlationId: 'corr',
    priorOutput: args.priorOutput,
    pipelineId: 'p' as AtomId,
    seedAtomIds: ['intent-foo' as AtomId],
    verifiedCitedAtomIds: args.verifiedCitedAtomIds,
    verifiedSubActorPrincipalIds: args.verifiedSubActorPrincipalIds ?? [],
  };
}
