/**
 * Tests for the plan-stage validator-retry loop (closes #339).
 *
 * Sibling pattern to auditor-feedback-reprompt.test.ts. Four surfaces
 * under test:
 *
 *   - `decideValidatorRetryAction`: pure decision helper. Asserts the
 *     five decision rules (empty error, empty allowlist, no pattern
 *     match, attempt cap, retry).
 *
 *   - `buildValidatorRetryContext`: pure prose formatter. Asserts the
 *     contract that the validator error is folded into a teaching
 *     prompt block with the canonical instruction text and truncation
 *     marker.
 *
 *   - `readPlanStageValidatorRetryPolicy`: canon-policy reader. Mirrors
 *     the contract of `readAuditorFeedbackRePromptPolicy`: null on
 *     absence, warn + null on malformed payload, skip tainted /
 *     superseded / non-L3 atoms.
 *
 *   - Runner integration: a stage that emits a schema-failing payload
 *     on attempt 1 and a clean payload on attempt 2 advances past the
 *     validator; a stage that emits a schema-failing payload on every
 *     attempt halts with schema-validation-failed; a non-recoverable
 *     error class halts immediately; max_attempts=1 disables retry.
 *
 * Closes task #339 -- the validator-retry pattern that mirrors #293
 * (auditor-feedback-reprompt) but teaches back BEFORE persistence
 * rather than AFTER audit, matching the operator's north-star
 * `feedback_pipeline_must_match_or_beat_in_session` (the pipeline
 * iterates on a single-error drafter mistake instead of halting).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  PLAN_STAGE_VALIDATOR_RETRY_HARDCODED_DEFAULT,
  buildValidatorRetryContext,
  decideValidatorRetryAction,
  readPlanStageValidatorRetryPolicy,
  runPipeline,
  type PlanStageValidatorRetryConfig,
  type PlanningStage,
} from '../../../src/runtime/planning-pipeline/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-12T12:00:00.000Z' as Time;

/**
 * Mirror of captureStderr from
 * test/runtime/planning-pipeline/auditor-feedback-reprompt.test.ts.
 * Replaces console.error in-place so the reader's warn-on-malformed
 * output is asserted without leaking into vitest's reporter output.
 */
function captureStderr(): {
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
  restore: () => void;
} {
  const original = console.error;
  const captured: unknown[][] = [];
  const replacement: typeof console.error = (...args: unknown[]): void => {
    captured.push(args);
  };
  console.error = replacement;
  return {
    calls: captured,
    restore: () => {
      console.error = original;
    },
  };
}

async function readWithCapturedStderr(
  host: ReturnType<typeof createMemoryHost>,
): Promise<{
  readonly result: Awaited<ReturnType<typeof readPlanStageValidatorRetryPolicy>>;
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
}> {
  const cap = captureStderr();
  try {
    const result = await readPlanStageValidatorRetryPolicy(host);
    return { result, calls: cap.calls };
  } finally {
    cap.restore();
  }
}

interface PolicyFields {
  readonly max_attempts?: unknown;
  readonly recoverable_error_patterns?: unknown;
}

function policyAtom(
  id: string,
  fields: PolicyFields,
  overrides: Partial<Atom> = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'plan-stage validator-retry policy',
    type: 'directive',
    layer: 'L3',
    provenance: {
      kind: 'operator-seeded',
      source: { agent_id: 'bootstrap' },
      derived_from: [],
    },
    confidence: 1,
    created_at: NOW,
    last_reinforced_at: NOW,
    expires_at: null,
    supersedes: [],
    superseded_by: [],
    scope: 'project',
    signals: {
      agrees_with: [],
      conflicts_with: [],
      validation_status: 'unchecked',
      last_validated_at: null,
    },
    principal_id: 'apex-agent' as PrincipalId,
    taint: 'clean',
    metadata: {
      policy: {
        subject: 'plan-stage-validator-retry-default',
        ...fields,
      },
    },
    ...overrides,
  };
}

/**
 * Seed pause_mode='never' policy atoms for the supplied stage names so
 * the runner does not halt on the fail-closed HIL default. Mirrors the
 * fixture in auditor-feedback-reprompt.test.ts so the runner-
 * integration tests share one helper shape.
 */
async function seedPauseNeverPolicies(
  host: ReturnType<typeof createMemoryHost>,
  stageNames: ReadonlyArray<string>,
): Promise<void> {
  for (const stageName of stageNames) {
    await host.atoms.put({
      schema_version: 1,
      id: `pol-pipeline-stage-hil-${stageName}-test` as AtomId,
      content: `test-fixture pause_mode=never for ${stageName}`,
      type: 'directive',
      layer: 'L3',
      provenance: {
        kind: 'operator-seeded',
        source: { tool: 'test-fixture' },
        derived_from: [],
      },
      confidence: 1,
      created_at: NOW,
      last_reinforced_at: NOW,
      expires_at: null,
      supersedes: [],
      superseded_by: [],
      scope: 'project',
      signals: {
        agrees_with: [],
        conflicts_with: [],
        validation_status: 'unchecked',
        last_validated_at: null,
      },
      principal_id: 'operator-principal' as PrincipalId,
      taint: 'clean',
      metadata: {
        policy: {
          subject: 'pipeline-stage-hil',
          stage_name: stageName,
          pause_mode: 'never',
          auto_resume_after_ms: null,
          allowed_resumers: [],
        },
      },
    });
  }
}

const DEFAULT_CONFIG: PlanStageValidatorRetryConfig = {
  max_attempts: 2,
  recoverable_error_patterns: ['schema-validation-failed'],
};

describe('decideValidatorRetryAction', () => {
  it("returns 'retry' on recoverable error message under attempt cap", () => {
    const decision = decideValidatorRetryAction(
      'schema-validation-failed: plans[0].target_paths partial',
      1,
      DEFAULT_CONFIG,
    );
    expect(decision.action).toBe('retry');
    if (decision.action === 'retry') {
      // feedbackText is the formatted prose for stage adapters that
      // want a single-call decision-plus-text path. The format is
      // exercised separately in buildValidatorRetryContext tests; here
      // we assert the field is populated and includes the error.
      expect(decision.feedbackText).toContain('schema-validation-failed');
      expect(decision.feedbackText).toContain('plans[0].target_paths partial');
    }
  });

  it("returns 'halt' at the attempt cap", () => {
    // previousAttempts=2 with max_attempts=2: the second attempt's
    // failure exhausted the cap, halt is the correct decision.
    const decision = decideValidatorRetryAction(
      'schema-validation-failed: any error',
      2,
      DEFAULT_CONFIG,
    );
    expect(decision.action).toBe('halt');
  });

  it("returns 'halt' on empty error message (defensive branch)", () => {
    // Caller is expected to supply a non-empty error message; the
    // explicit branch keeps the contract loud rather than relying on
    // caller discipline.
    const decision = decideValidatorRetryAction('', 1, DEFAULT_CONFIG);
    expect(decision.action).toBe('halt');
  });

  it("returns 'halt' on empty recoverable_error_patterns (explicit disable)", () => {
    // The empty-allowlist case is the explicit disable: the operator
    // left the policy atom present but cleared the trigger list, so
    // no retry ever fires regardless of max_attempts.
    const disabled: PlanStageValidatorRetryConfig = {
      max_attempts: 2,
      recoverable_error_patterns: [],
    };
    const decision = decideValidatorRetryAction(
      'schema-validation-failed: anything',
      1,
      disabled,
    );
    expect(decision.action).toBe('halt');
  });

  it("returns 'halt' on novel error class not matching any pattern (default-deny)", () => {
    // The recoverable_error_patterns is the operator-stated allowlist.
    // An error message that does NOT contain any configured pattern
    // halts immediately; the substrate fails closed on a novel error
    // class so the operator sees the new failure mode rather than
    // silently retrying.
    const decision = decideValidatorRetryAction(
      'intent-expired-between-attempts: trust envelope no longer valid',
      1,
      DEFAULT_CONFIG,
    );
    expect(decision.action).toBe('halt');
  });

  it('respects a narrowed pattern allowlist (specific zod error path)', () => {
    // An org-ceiling deployment that narrows to specific Zod error-
    // path substrings (e.g. only target_paths shapes) sees retry fire
    // only on the matching shape; other schema errors halt.
    const narrowed: PlanStageValidatorRetryConfig = {
      max_attempts: 2,
      recoverable_error_patterns: ['target_paths'],
    };
    const onTargetPaths = decideValidatorRetryAction(
      'schema-validation-failed: plans[0].target_paths partial',
      1,
      narrowed,
    );
    expect(onTargetPaths.action).toBe('retry');
    const onConfidence = decideValidatorRetryAction(
      'schema-validation-failed: plans[0].confidence out of [0,1]',
      1,
      narrowed,
    );
    expect(onConfidence.action).toBe('halt');
  });

  it("returns 'halt' when max_attempts=1 (no retry budget)", () => {
    // The substrate posture: max_attempts >= 2 enables retry (attempt
    // 1 + retry); max_attempts=1 means attempt 1 only, no retry. A
    // canon edit setting max_attempts=1 is the dial for "no retry
    // without removing the policy atom".
    const noRetry: PlanStageValidatorRetryConfig = {
      max_attempts: 1,
      recoverable_error_patterns: ['schema-validation-failed'],
    };
    const decision = decideValidatorRetryAction(
      'schema-validation-failed: any error',
      1,
      noRetry,
    );
    expect(decision.action).toBe('halt');
  });

  it("returns 'halt' on malformed max_attempts (NaN coerces to 0)", () => {
    // Fail-closed on malformed config: a NaN max_attempts (somehow
    // bypassing the canon reader) collapses to 0 in the safety
    // coercion, which makes previousAttempts >= 0 trivially true and
    // halts. Mirrors the same posture in decideRePromptAction.
    const broken: PlanStageValidatorRetryConfig = {
      max_attempts: NaN,
      recoverable_error_patterns: ['schema-validation-failed'],
    };
    const decision = decideValidatorRetryAction(
      'schema-validation-failed: any error',
      0,
      broken,
    );
    expect(decision.action).toBe('halt');
  });
});

describe('buildValidatorRetryContext', () => {
  it('concatenates validator error into prompt section', () => {
    const context = buildValidatorRetryContext(
      'BASE_PROMPT',
      'schema-validation-failed: plans[0].target_paths partial',
    );
    expect(context.startsWith('BASE_PROMPT')).toBe(true);
    expect(context).toContain('Your prior attempt produced this schema-validation error');
    expect(context).toContain('<validator-error>');
    expect(context).toContain('schema-validation-failed: plans[0].target_paths partial');
    expect(context).toContain('</validator-error>');
  });

  it('renders the canonical instruction block with common shape hints', () => {
    const context = buildValidatorRetryContext(
      '',
      'schema-validation-failed: plans[0].target_paths partial',
    );
    // The teaching prose should hint at the common LLM-recoverable
    // shapes so the next attempt has guidance before re-reading the
    // schema constraints. The prose is a substring assertion; future
    // edits to the wording are caught by this test.
    expect(context).toMatch(/target_paths partial/i);
    expect(context).toMatch(/bare filename/i);
    expect(context).toMatch(/gitignored/i);
    expect(context).toMatch(/confidence/i);
  });

  it('truncates over-long error messages with explicit marker', () => {
    const giant = 'schema-validation-failed: ' + 'x'.repeat(10_000);
    const context = buildValidatorRetryContext('', giant);
    expect(context).toContain('[truncated]');
    // Bound the appended block well under the 10kB raw input.
    expect(context.length).toBeLessThan(giant.length);
  });

  it('returns originalPromptContext unchanged on empty error', () => {
    const context = buildValidatorRetryContext('UNCHANGED', '');
    expect(context).toBe('UNCHANGED');
  });
});

describe('readPlanStageValidatorRetryPolicy', () => {
  it('returns null on absence', async () => {
    const host = createMemoryHost();
    expect(await readPlanStageValidatorRetryPolicy(host)).toBeNull();
  });

  it('returns config on valid policy atom', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-plan-stage-validator-retry-default', {
        max_attempts: 3,
        recoverable_error_patterns: ['schema-validation-failed', 'target_paths'],
      }),
    );
    expect(await readPlanStageValidatorRetryPolicy(host)).toEqual({
      max_attempts: 3,
      recoverable_error_patterns: ['schema-validation-failed', 'target_paths'],
    });
  });

  it('returns null + warns on malformed payload (non-integer max_attempts)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bad-max', {
        max_attempts: 'two',
        recoverable_error_patterns: ['schema-validation-failed'],
      }),
    );
    const { result, calls } = await readWithCapturedStderr(host);
    expect(result).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('max_attempts');
  });

  it('returns null + warns on malformed payload (non-string in patterns list)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bad-pattern', {
        max_attempts: 2,
        recoverable_error_patterns: ['schema-validation-failed', 42],
      }),
    );
    const { result, calls } = await readWithCapturedStderr(host);
    expect(result).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('recoverable_error_patterns');
  });

  it('returns null + warns on malformed payload (empty string in patterns list)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bad-empty-pattern', {
        max_attempts: 2,
        recoverable_error_patterns: ['schema-validation-failed', ''],
      }),
    );
    const { result, calls } = await readWithCapturedStderr(host);
    expect(result).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('recoverable_error_patterns');
  });

  it('accepts an empty patterns list as explicit disable', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-disable', {
        max_attempts: 2,
        recoverable_error_patterns: [],
      }),
    );
    expect(await readPlanStageValidatorRetryPolicy(host)).toEqual({
      max_attempts: 2,
      recoverable_error_patterns: [],
    });
  });

  it('skips tainted atoms', async () => {
    const host = createMemoryHost();
    const atom = policyAtom('pol-tainted', {
      max_attempts: 2,
      recoverable_error_patterns: ['schema-validation-failed'],
    });
    await host.atoms.put({ ...atom, taint: 'tainted' });
    expect(await readPlanStageValidatorRetryPolicy(host)).toBeNull();
  });

  it('skips superseded atoms', async () => {
    const host = createMemoryHost();
    const atom = policyAtom('pol-superseded', {
      max_attempts: 2,
      recoverable_error_patterns: ['schema-validation-failed'],
    });
    await host.atoms.put({ ...atom, superseded_by: ['pol-newer' as AtomId] });
    expect(await readPlanStageValidatorRetryPolicy(host)).toBeNull();
  });

  it('skips non-L3 atoms (forgery containment)', async () => {
    // A same-subject directive at L0/L1/L2 must NOT impersonate
    // authoritative canon. Mirrors the L3-only scan posture in
    // readAuditorFeedbackRePromptPolicy.
    const host = createMemoryHost();
    const atom = policyAtom('pol-l0', {
      max_attempts: 99,
      recoverable_error_patterns: ['anything'],
    });
    await host.atoms.put({ ...atom, layer: 'L0' });
    expect(await readPlanStageValidatorRetryPolicy(host)).toBeNull();
  });

  it('exports the hardcoded default constant matching the brief', () => {
    // The canon seed mirrors the hardcoded floor so an existing
    // deployment that runs the bootstrap for the first time observes
    // identical behavior to its pre-canon-policy run. Pin the
    // constant value here so a future edit to either side is caught
    // as a drift in tests rather than at runtime.
    expect(PLAN_STAGE_VALIDATOR_RETRY_HARDCODED_DEFAULT).toEqual({
      max_attempts: 2,
      recoverable_error_patterns: ['schema-validation-failed'],
    });
  });
});

/**
 * A minimal stage schema that catches the canonical "missing required
 * field" Zod error so the runner-integration tests can drive the
 * validator-retry loop deterministically. The shape is intentionally
 * small (no plan-shape coupling) so the test stays focused on the
 * runner behaviour rather than the plan-stage adapter.
 */
const testStageSchema = z.object({
  ok: z.number(),
  body: z.string().min(1),
});

describe('runPipeline plan-stage validator-retry integration', () => {
  it('retries on recoverable validator failure, advances when attempt 2 is clean', async () => {
    // The textbook validator-retry success path. Attempt 1 emits a
    // payload that fails schema (missing body); attempt 2 (the retry)
    // emits a clean payload. The runner advances to completion rather
    // than halting on the attempt-1 failure.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['retry-validator-stage']);
    let runCount = 0;
    let priorValidatorErrorOnAttempt2: string | null = null;
    const stage: PlanningStage<unknown, z.infer<typeof testStageSchema>> = {
      name: 'retry-validator-stage',
      outputSchema: testStageSchema,
      async run(input) {
        runCount++;
        if (runCount === 2) {
          // Capture what the runner threaded into priorValidatorError
          // on the second attempt. The stage adapter side of the
          // contract is "see prior error, self-correct"; the runner
          // side is "fold the validator error into the next attempt's
          // input". This test asserts the runner side.
          priorValidatorErrorOnAttempt2 = input.priorValidatorError;
        }
        return {
          // Attempt 1: missing body (schema fail). Attempt 2: clean.
          value: runCount === 1
            ? ({ ok: 1 } as unknown as z.infer<typeof testStageSchema>)
            : { ok: 2, body: 'clean payload' },
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-validator-retry-success',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
    expect(runCount).toBe(2);
    // The second attempt MUST have seen attempt-1's validator error
    // folded in. The runner threads the runner-constructed prefix
    // shape `schema-validation-failed: <zod error>` so the policy
    // reader's pattern match is substring-stable.
    expect(priorValidatorErrorOnAttempt2).not.toBeNull();
    expect(priorValidatorErrorOnAttempt2).toContain('schema-validation-failed');
    // The validator-retry-after-failure event MUST be on the audit
    // trail so an audit walk renders the teaching seam without
    // re-running the stage.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    const retryEvents = events.atoms.filter(
      (a) => (a.metadata as Record<string, unknown>)?.transition
        === 'validator-retry-after-failure',
    );
    expect(retryEvents.length).toBe(1);
    const retryMeta = retryEvents[0]!.metadata as Record<string, unknown>;
    expect(retryMeta.attempt_index).toBe(2);
    expect(String(retryMeta.validator_error_message)).toContain('schema-validation-failed');
  });

  it('halts with schema-validation-failed when validator fails at the attempt cap', async () => {
    // The attempt cap is reached: attempt 1 + attempt 2 both produced
    // schema failures; the runner halts on attempt 2's failure via
    // the existing schema-validation-failed cause. Net atoms written:
    // 1 retry event between attempt 1 and 2, plus 1 pipeline-failed
    // on attempt 2's halt.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stubborn-validator-stage']);
    let runCount = 0;
    const stage: PlanningStage<unknown, z.infer<typeof testStageSchema>> = {
      name: 'stubborn-validator-stage',
      outputSchema: testStageSchema,
      async run() {
        runCount++;
        return {
          // Every attempt: missing body. Schema fails every time.
          value: { ok: runCount } as unknown as z.infer<typeof testStageSchema>,
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-validator-retry-exhausted',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failedStageName).toBe('stubborn-validator-stage');
      // The cause string is the unmodified zod prefix shape.
      expect(result.cause).toContain('schema-validation-failed');
    }
    // The runner ran exactly max_attempts (2) attempts -- never
    // exceeds the cap, never silently advances.
    expect(runCount).toBe(2);
    // Exactly one validator-retry-after-failure event (between
    // attempt 1 and attempt 2); no second retry was triggered after
    // attempt 2's failure (the cap halts the loop).
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    const retryEvents = events.atoms.filter(
      (a) => (a.metadata as Record<string, unknown>)?.transition
        === 'validator-retry-after-failure',
    );
    expect(retryEvents.length).toBe(1);
    // The pipeline-failed atom is on disk.
    const failedEvents = await host.atoms.query({ type: ['pipeline-failed'] }, 100);
    expect(failedEvents.atoms.length).toBe(1);
  });

  it('halts immediately on non-recoverable error class (default-deny)', async () => {
    // A custom error class outside the configured recoverable patterns
    // halts immediately; no retry is attempted. This is the substrate
    // posture for novel error classes: surface to the operator rather
    // than silently retrying a failure mode the operator has NOT
    // authorized.
    //
    // Constructed by overriding the canon policy to a narrow allowlist
    // that does NOT match the runner's prefix. The stage emits a
    // payload that fails schema; the runner's cause string contains
    // 'schema-validation-failed' but the policy only authorizes
    // 'foo-bar-baz' as recoverable, so retry never fires.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['nonrecoverable-stage']);
    await host.atoms.put(
      policyAtom('pol-plan-stage-validator-retry-default', {
        max_attempts: 2,
        recoverable_error_patterns: ['foo-bar-baz'],
      }),
    );
    let runCount = 0;
    const stage: PlanningStage<unknown, z.infer<typeof testStageSchema>> = {
      name: 'nonrecoverable-stage',
      outputSchema: testStageSchema,
      async run() {
        runCount++;
        return {
          value: { ok: runCount } as unknown as z.infer<typeof testStageSchema>,
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-nonrecoverable',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    // Exactly one attempt: novel error class halted immediately, no
    // retry was attempted.
    expect(runCount).toBe(1);
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    const retryEvents = events.atoms.filter(
      (a) => (a.metadata as Record<string, unknown>)?.transition
        === 'validator-retry-after-failure',
    );
    expect(retryEvents.length).toBe(0);
  });

  it('disables retry when canon policy sets max_attempts=1', async () => {
    // Canon-edit case: the operator narrows the dial to max_attempts=1,
    // effectively disabling retry without removing the policy atom.
    // A single schema failure halts immediately. This is the same
    // shape as the empty-allowlist case but driven by the max_attempts
    // dial instead of the patterns dial.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['no-retry-stage']);
    await host.atoms.put(
      policyAtom('pol-plan-stage-validator-retry-default', {
        max_attempts: 1,
        recoverable_error_patterns: ['schema-validation-failed'],
      }),
    );
    let runCount = 0;
    const stage: PlanningStage<unknown, z.infer<typeof testStageSchema>> = {
      name: 'no-retry-stage',
      outputSchema: testStageSchema,
      async run() {
        runCount++;
        return {
          value: { ok: runCount } as unknown as z.infer<typeof testStageSchema>,
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-max-attempts-1',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    expect(runCount).toBe(1);
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    const retryEvents = events.atoms.filter(
      (a) => (a.metadata as Record<string, unknown>)?.transition
        === 'validator-retry-after-failure',
    );
    expect(retryEvents.length).toBe(0);
  });

  it('audit-chain integrity: retry event has provenance.derived_from -> pipelineId', async () => {
    // The retry event MUST chain back to the pipeline atom so an
    // audit walk can reconstruct the full pipeline lineage from any
    // mid-stage atom alone. Without this, the substrate-level
    // "every atom must carry provenance with a source chain"
    // directive is broken. Mirrors the same chain shape on
    // retry-after-findings + pipeline-stage-event atoms.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['chain-stage']);
    let runCount = 0;
    const stage: PlanningStage<unknown, z.infer<typeof testStageSchema>> = {
      name: 'chain-stage',
      outputSchema: testStageSchema,
      async run() {
        runCount++;
        return {
          value: runCount === 1
            ? ({ ok: 1 } as unknown as z.infer<typeof testStageSchema>)
            : { ok: 2, body: 'clean' },
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec-output',
        };
      },
    };
    await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-chain',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    const retryEvent = events.atoms.find(
      (a) => (a.metadata as Record<string, unknown>)?.transition
        === 'validator-retry-after-failure',
    );
    expect(retryEvent).toBeDefined();
    if (retryEvent !== undefined) {
      // derived_from must include the pipeline atom id.
      expect(retryEvent.provenance.derived_from.length).toBeGreaterThan(0);
      const pipelineId = 'pipeline-corr-chain';
      expect(retryEvent.provenance.derived_from.map(String)).toContain(pipelineId);
    }
  });
});
