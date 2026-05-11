/**
 * Tests for the auditor-feedback re-prompt loop.
 *
 * Three surfaces under test:
 *
 *   - `decideRePromptAction`: pure decision helper. Asserts the four
 *     decision rules (empty findings, non-actionable findings, attempt
 *     cap, re-prompt).
 *
 *   - `buildRePromptContext`: pure prose formatter. Asserts the
 *     contract that findings are bullet-formatted with severity +
 *     category + message + citation lists.
 *
 *   - `readAuditorFeedbackRePromptPolicy`: canon-policy reader. Mirrors
 *     the contract of `readLoopPassClaimReaperFromCanon`: null on
 *     absence, warn + null on malformed payload, skip tainted /
 *     superseded / non-L3 atoms.
 *
 *   - Runner integration: a stage that emits a critical finding on
 *     attempt 1 and a clean payload on attempt 2 advances past the
 *     audit gate; a stage that emits a critical finding on every
 *     attempt halts with attempts_exhausted; a minor-only finding
 *     stays accepted (no re-prompt).
 */

import { describe, expect, it } from 'vitest';

import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import {
  AUDITOR_FEEDBACK_REPROMPT_HARDCODED_DEFAULT,
  buildRePromptContext,
  decideRePromptAction,
  readAuditorFeedbackRePromptPolicy,
  runPipeline,
  type AuditFinding,
  type AuditorFeedbackRePromptConfig,
  type PlanningStage,
} from '../../../src/runtime/planning-pipeline/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-05-11T12:00:00.000Z' as Time;

/**
 * Mirror of captureStderr from test/runtime/loop/claim-reaper-pass.test.ts.
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
  readonly result: Awaited<ReturnType<typeof readAuditorFeedbackRePromptPolicy>>;
  readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
}> {
  const cap = captureStderr();
  try {
    const result = await readAuditorFeedbackRePromptPolicy(host);
    return { result, calls: cap.calls };
  } finally {
    cap.restore();
  }
}

interface PolicyFields {
  readonly max_attempts?: unknown;
  readonly severities_to_reprompt?: unknown;
}

function policyAtom(
  id: string,
  fields: PolicyFields,
  overrides: Partial<Atom> = {},
): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content: 'auditor-feedback-reprompt policy',
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
        subject: 'auditor-feedback-reprompt-default',
        ...fields,
      },
    },
    ...overrides,
  };
}

/**
 * Seed pause_mode='never' policy atoms for the supplied stage names so
 * the runner does not halt on the fail-closed HIL default. Mirrors the
 * fixture in runner.test.ts; inlined here so the file stays
 * self-contained.
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

const mkFinding = (
  severity: AuditFinding['severity'],
  message = 'cite not in verified set',
): AuditFinding => ({
  severity,
  category: 'cite-fail',
  message,
  cited_atom_ids: [],
  cited_paths: [],
});

const DEFAULT_CONFIG: AuditorFeedbackRePromptConfig = {
  max_attempts: 2,
  severities_to_reprompt: ['critical'],
};

describe('decideRePromptAction', () => {
  it("returns 'reprompt' on critical finding under attempt cap", () => {
    const decision = decideRePromptAction([mkFinding('critical')], 1, DEFAULT_CONFIG);
    expect(decision.action).toBe('reprompt');
    if (decision.action === 'reprompt') {
      // feedbackText is the formatted prose for stage adapters that
      // want a single-call decision-plus-text path. The format is
      // exercised separately in buildRePromptContext tests; here we
      // assert the field is populated and includes the finding.
      expect(decision.feedbackText).toContain('[critical] cite-fail');
    }
  });

  it("returns 'halt' on critical finding at attempt cap", () => {
    // previousAttempts=2 with max_attempts=2: the second attempt's
    // findings exhausted the cap, halt is the correct decision.
    const decision = decideRePromptAction([mkFinding('critical')], 2, DEFAULT_CONFIG);
    expect(decision.action).toBe('halt');
  });

  it("returns 'halt' on minor finding (severity not in config)", () => {
    // The default config only re-prompts on 'critical'. A minor
    // finding is below the floor, so the gate is closed and the
    // runner's existing accept-on-non-critical path handles the
    // advisory finding.
    const decision = decideRePromptAction([mkFinding('minor')], 1, DEFAULT_CONFIG);
    expect(decision.action).toBe('halt');
  });

  it("returns 'halt' on no findings (defensive branch)", () => {
    // Caller is expected to short-circuit before reaching the
    // decision helper when findings are empty (no findings = stage
    // passed audit), but the explicit branch keeps the contract loud
    // rather than relying on caller discipline.
    const decision = decideRePromptAction([], 1, DEFAULT_CONFIG);
    expect(decision.action).toBe('halt');
  });

  it('respects a widened severities list (critical + major)', () => {
    // An org-ceiling deployment that widens the list to teach back
    // on majors too sees the re-prompt fire on a major-only finding.
    const widened: AuditorFeedbackRePromptConfig = {
      max_attempts: 2,
      severities_to_reprompt: ['critical', 'major'],
    };
    const decision = decideRePromptAction([mkFinding('major')], 1, widened);
    expect(decision.action).toBe('reprompt');
  });

  it('respects an empty severities list as explicit disable', () => {
    // The empty-allowlist case is the explicit disable: the operator
    // left the policy atom present but cleared the trigger list, so
    // no re-prompt ever fires regardless of max_attempts.
    const disabled: AuditorFeedbackRePromptConfig = {
      max_attempts: 2,
      severities_to_reprompt: [],
    };
    const decision = decideRePromptAction([mkFinding('critical')], 1, disabled);
    expect(decision.action).toBe('halt');
  });
});

describe('buildRePromptContext', () => {
  it('concatenates findings into prompt section', () => {
    const context = buildRePromptContext(
      'BASE_PROMPT',
      [mkFinding('critical', 'cite atom-foo unknown'), mkFinding('major', 'cite atom-bar drifted')],
    );
    expect(context.startsWith('BASE_PROMPT')).toBe(true);
    expect(context).toContain('Your prior attempt produced these audit findings');
    expect(context).toContain('[critical] cite-fail: cite atom-foo unknown');
    expect(context).toContain('[major] cite-fail: cite atom-bar drifted');
  });

  it('renders cited_paths and cited_atom_ids on a finding', () => {
    const finding: AuditFinding = {
      severity: 'critical',
      category: 'path-fab',
      message: 'fabricated path',
      cited_atom_ids: ['atom-foo' as AtomId, 'atom-bar' as AtomId],
      cited_paths: ['nope.ts', 'also-nope.md'],
    };
    const context = buildRePromptContext('', [finding]);
    expect(context).toContain('cited_paths: nope.ts, also-nope.md');
    expect(context).toContain('cited_atom_ids: atom-foo, atom-bar');
  });

  it('returns originalPromptContext unchanged on empty findings', () => {
    const context = buildRePromptContext('UNCHANGED', []);
    expect(context).toBe('UNCHANGED');
  });
});

describe('readAuditorFeedbackRePromptPolicy', () => {
  it('returns null on absence', async () => {
    const host = createMemoryHost();
    expect(await readAuditorFeedbackRePromptPolicy(host)).toBeNull();
  });

  it('returns config on valid policy atom', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-auditor-feedback-reprompt-default', {
        max_attempts: 3,
        severities_to_reprompt: ['critical', 'major'],
      }),
    );
    expect(await readAuditorFeedbackRePromptPolicy(host)).toEqual({
      max_attempts: 3,
      severities_to_reprompt: ['critical', 'major'],
    });
  });

  it('returns null + warns on malformed payload (non-integer max_attempts)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bad-max', {
        max_attempts: 'two',
        severities_to_reprompt: ['critical'],
      }),
    );
    const { result, calls } = await readWithCapturedStderr(host);
    expect(result).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('max_attempts');
  });

  it('returns null + warns on malformed payload (unknown severity in list)', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-bad-sev', {
        max_attempts: 2,
        severities_to_reprompt: ['critical', 'apocalyptic'],
      }),
    );
    const { result, calls } = await readWithCapturedStderr(host);
    expect(result).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]?.[0])).toContain('apocalyptic');
  });

  it('accepts an empty severities list as explicit disable', async () => {
    const host = createMemoryHost();
    await host.atoms.put(
      policyAtom('pol-disable', {
        max_attempts: 2,
        severities_to_reprompt: [],
      }),
    );
    expect(await readAuditorFeedbackRePromptPolicy(host)).toEqual({
      max_attempts: 2,
      severities_to_reprompt: [],
    });
  });

  it('skips tainted atoms', async () => {
    const host = createMemoryHost();
    const atom = policyAtom('pol-tainted', {
      max_attempts: 2,
      severities_to_reprompt: ['critical'],
    });
    await host.atoms.put({ ...atom, taint: 'tainted' });
    expect(await readAuditorFeedbackRePromptPolicy(host)).toBeNull();
  });

  it('skips superseded atoms', async () => {
    const host = createMemoryHost();
    const atom = policyAtom('pol-superseded', {
      max_attempts: 2,
      severities_to_reprompt: ['critical'],
    });
    await host.atoms.put({ ...atom, superseded_by: ['pol-newer' as AtomId] });
    expect(await readAuditorFeedbackRePromptPolicy(host)).toBeNull();
  });

  it('skips non-L3 atoms (forgery containment)', async () => {
    // A same-subject directive at L0/L1/L2 must NOT impersonate
    // authoritative canon. Mirrors the L3-only scan posture in
    // readLoopPassClaimReaperFromCanon and canon-policy-cadence.ts.
    const host = createMemoryHost();
    const atom = policyAtom('pol-l0', {
      max_attempts: 99,
      severities_to_reprompt: ['critical', 'major', 'minor'],
    });
    await host.atoms.put({ ...atom, layer: 'L0' });
    expect(await readAuditorFeedbackRePromptPolicy(host)).toBeNull();
  });

  it('exports the hardcoded default constant matching the brief', () => {
    // The canon seed mirrors the hardcoded floor so an existing
    // deployment that runs the bootstrap for the first time observes
    // identical behavior to its pre-canon-policy run. Pin the
    // constant value here so a future edit to either side is caught
    // as a drift in tests rather than at runtime.
    expect(AUDITOR_FEEDBACK_REPROMPT_HARDCODED_DEFAULT).toEqual({
      max_attempts: 2,
      severities_to_reprompt: ['critical'],
    });
  });
});

describe('runPipeline auditor-feedback re-prompt integration', () => {
  it('re-prompts on critical finding, advances when second attempt is clean', async () => {
    // The textbook re-prompt success path. Attempt 1 produces a
    // critical finding; attempt 2 (the re-prompt) produces no
    // findings. The runner advances to completion rather than
    // halting on the attempt-1 finding.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['re-prompt-stage']);
    let runCount = 0;
    let priorFindingsOnAttempt2: ReadonlyArray<AuditFinding> | null = null;
    const stage: PlanningStage<unknown, { ok: number }> = {
      name: 're-prompt-stage',
      async run(input) {
        runCount++;
        if (runCount === 2) {
          // Capture what the runner threaded into priorAuditFindings
          // on the second attempt. The stage adapter side of the
          // contract is "see prior findings, self-correct"; the
          // runner side is "fold the actionable findings into the
          // next attempt's input". This test asserts the runner side.
          priorFindingsOnAttempt2 = input.priorAuditFindings;
        }
        return {
          value: { ok: runCount },
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec',
        };
      },
      async audit(value) {
        // Attempt 1 produces a critical finding; attempt 2 (the
        // re-prompt) produces none. The stage's `value` carries the
        // runCount-stamped ok field so the audit can discriminate
        // by attempt without a closure-stash.
        if ((value as { ok: number }).ok === 1) {
          return [mkFinding('critical', 'attempt-1 cite-fail')];
        }
        return [];
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-reprompt-success',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
    expect(runCount).toBe(2);
    // The second attempt MUST have seen attempt-1's findings folded
    // in. The runner filters by severities_to_reprompt (default
    // ['critical']) before forwarding, so the array carries the
    // critical finding only.
    expect(priorFindingsOnAttempt2).not.toBeNull();
    expect(priorFindingsOnAttempt2?.length).toBe(1);
    expect(priorFindingsOnAttempt2?.[0]?.severity).toBe('critical');
    // The retry-after-findings event MUST be on the audit trail so
    // an audit walk renders the teaching seam without re-running
    // the stage.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    const retryEvents = events.atoms.filter(
      (a) => (a.metadata as Record<string, unknown>)?.transition === 'retry-after-findings',
    );
    expect(retryEvents.length).toBe(1);
    const retryMeta = retryEvents[0]!.metadata as Record<string, unknown>;
    expect(retryMeta.attempt_index).toBe(2);
    expect(retryMeta.findings_summary).toEqual({ critical: 1, major: 0, minor: 0 });
  });

  it('halts with critical-audit-finding when a critical finding recurs at the attempt cap', async () => {
    // The attempt cap is reached: attempt 1 + attempt 2 both
    // produced critical findings; the runner halts on attempt 2's
    // finding via the existing critical-audit-finding cause.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['stubborn-stage']);
    let runCount = 0;
    const stage: PlanningStage<unknown, { ok: number }> = {
      name: 'stubborn-stage',
      async run() {
        runCount++;
        return {
          value: { ok: runCount },
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec',
        };
      },
      async audit() {
        return [mkFinding('critical', 'recurring cite-fail')];
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-reprompt-exhausted',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failedStageName).toBe('stubborn-stage');
      expect(result.cause).toBe('critical-audit-finding');
    }
    // The runner ran exactly max_attempts (2) attempts -- never
    // exceeds the cap, never silently advances.
    expect(runCount).toBe(2);
    // Exactly one retry-after-findings event (between attempt 1 and
    // attempt 2); no third retry was triggered.
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    const retryEvents = events.atoms.filter(
      (a) => (a.metadata as Record<string, unknown>)?.transition === 'retry-after-findings',
    );
    expect(retryEvents.length).toBe(1);
  });

  it('halts immediately on minor finding without re-prompt (severity gate)', async () => {
    // A minor-only finding is below the configured severity floor.
    // The runner skips the re-prompt and falls through to the
    // existing post-audit path; no critical means accept the output,
    // emit exit-success, and advance to completion.
    const host = createMemoryHost();
    await seedPauseNeverPolicies(host, ['minor-stage']);
    let runCount = 0;
    const stage: PlanningStage<unknown, unknown> = {
      name: 'minor-stage',
      async run() {
        runCount++;
        return {
          value: {},
          cost_usd: 0,
          duration_ms: 0,
          atom_type: 'spec',
        };
      },
      async audit() {
        return [mkFinding('minor', 'advisory only')];
      },
    };
    const result = await runPipeline([stage], host, {
      principal: 'cto-actor' as PrincipalId,
      correlationId: 'corr-minor-no-reprompt',
      seedAtomIds: ['intent-1' as AtomId],
      now: () => NOW,
      mode: 'substrate-deep',
      stagePolicyAtomId: 'pol-test',
    });
    expect(result.kind).toBe('completed');
    // Exactly one attempt: minor finding was advisory, no re-prompt.
    expect(runCount).toBe(1);
    const events = await host.atoms.query({ type: ['pipeline-stage-event'] }, 100);
    const retryEvents = events.atoms.filter(
      (a) => (a.metadata as Record<string, unknown>)?.transition === 'retry-after-findings',
    );
    expect(retryEvents.length).toBe(0);
  });
});
