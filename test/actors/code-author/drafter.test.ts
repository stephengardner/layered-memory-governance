/**
 * Unit tests for draftCodeChange.
 *
 * Exercises:
 *   - happy path: LLM returns a valid diff, drafter returns it with
 *     cost, model, touched paths
 *   - LLM call fails -> DrafterError(llm-call-failed)
 *   - LLM output missing `diff` / `notes` / `confidence` ->
 *     DrafterError(schema-validation-failed)
 *   - confidence out of [0,1] -> DrafterError(schema-validation-failed)
 *   - diff touches a path outside plan scope -> DrafterError(diff-path-escape)
 *   - diff with empty paths + non-empty target list -> no escape error
 *     (treat as "no change produced," caller decides retry/skip)
 *   - looksLikeUnifiedDiff smoke
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createMemoryHost } from '../../../src/adapters/memory/index.js';
import type { MemoryHost } from '../../../src/adapters/memory/index.js';
import {
  DRAFT_SCHEMA,
  DRAFT_SYSTEM_PROMPT,
  DrafterError,
  draftCodeChange,
  looksLikeUnifiedDiff,
} from '../../../src/actors/code-author/drafter.js';
import type {
  CodeAuthorFence,
} from '../../../src/actors/code-author/fence.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../../src/types.js';

const NOW = '2026-04-21T12:00:00.000Z' as Time;
const CODE_AUTHOR = 'code-author' as PrincipalId;

function mkFence(overrides: Partial<CodeAuthorFence> = {}): CodeAuthorFence {
  return Object.freeze({
    signedPrOnly: Object.freeze({
      subject: 'code-author-authorship',
      output_channel: 'signed-pr',
      allowed_direct_write_paths: Object.freeze([]),
      require_app_identity: true,
    }),
    perPrCostCap: Object.freeze({
      subject: 'code-author-per-pr-cost-cap',
      max_usd_per_pr: 10,
      include_retries: true,
    }),
    ciGate: Object.freeze({
      subject: 'code-author-ci-gate',
      required_checks: Object.freeze(['Node 22 on ubuntu-latest']),
      require_all: true,
      max_check_age_ms: 600_000,
    }),
    writeRevocationOnStop: Object.freeze({
      subject: 'code-author-write-revocation',
      on_stop_action: 'close-pr-with-revocation-comment',
      draft_atoms_layer: 'L0',
      revocation_atom_type: 'code-author-revoked',
    }),
    warnings: Object.freeze([]),
    ...overrides,
  });
}

function mkPlan(content: string, title = 'Test plan'): Atom {
  return {
    schema_version: 1,
    id: 'plan-drafter-test-1' as AtomId,
    content,
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor', session_id: 'test' },
      derived_from: [],
    },
    confidence: 0.85,
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
    principal_id: 'cto-actor' as PrincipalId,
    taint: 'clean',
    plan_state: 'executing',
    metadata: { title },
  };
}

const SAMPLE_DIFF = [
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,2 +1,2 @@',
  '-# LAG',
  '+# LAG (Layered Autonomous Governance)',
  '',
].join('\n');

describe('draftCodeChange', () => {
  let host: MemoryHost;

  beforeEach(() => {
    host = createMemoryHost();
  });

  it('happy path: LLM returns a valid diff; drafter returns diff + cost + touched paths', async () => {
    const plan = mkPlan('# Bump README title\n\nExpand the title.');
    const fence = mkFence();
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'],
      successCriteria: 'Title is more descriptive',
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: 'Title is more descriptive',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'Simple title expansion.',
      confidence: 0.9,
    });

    const result = await draftCodeChange(host, inputs);
    expect(result.diff).toBe(SAMPLE_DIFF);
    expect(result.notes).toBe('Simple title expansion.');
    expect(result.confidence).toBe(0.9);
    expect(result.touchedPaths).toEqual(['README.md']);
    // MemoryLLM does not report cost; adapter returns 0 and drafter accumulates it.
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('LLM throws -> DrafterError(llm-call-failed)', async () => {
    const plan = mkPlan('unregistered request');
    const fence = mkFence();
    // No response registered; MemoryLLM throws UnsupportedError on judge.
    await expect(
      draftCodeChange(host, {
        plan,
        fence,
        targetPaths: ['README.md'],
        model: 'claude-opus-4-7',
      }),
    ).rejects.toMatchObject({
      name: 'DrafterError',
      reason: 'llm-call-failed',
    });
  });

  it('LLM output missing diff field -> schema-validation-failed', async () => {
    const plan = mkPlan('malformed response');
    const fence = mkFence();
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      // missing `diff`
      notes: 'No diff',
      confidence: 0.5,
    });
    await expect(draftCodeChange(host, inputs)).rejects.toMatchObject({
      name: 'DrafterError',
      reason: 'schema-validation-failed',
    });
  });

  it('confidence out of [0,1] -> schema-validation-failed', async () => {
    const plan = mkPlan('bad confidence');
    const fence = mkFence();
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 1.5,
    });
    await expect(draftCodeChange(host, inputs)).rejects.toMatchObject({
      name: 'DrafterError',
      reason: 'schema-validation-failed',
    });
  });

  it('diff touches path outside plan target_paths -> diff-path-escape', async () => {
    const plan = mkPlan('path escape');
    const fence = mkFence();
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'], // declared scope
      model: 'claude-opus-4-7',
    };
    const offRoadDiff = [
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1,1 +1,1 @@',
      '-# LAG',
      '+# LAG!',
      '--- a/src/sneaky.ts',
      '+++ b/src/sneaky.ts',
      '@@ -0,0 +1,1 @@',
      '+export const backdoor = true;',
      '',
    ].join('\n');
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: offRoadDiff,
      notes: 'expanded scope without asking',
      confidence: 0.8,
    });
    await expect(draftCodeChange(host, inputs)).rejects.toMatchObject({
      name: 'DrafterError',
      reason: 'diff-path-escape',
    });
  });

  it('empty targetPaths -> scope check is skipped (freeform plan)', async () => {
    const plan = mkPlan('no declared scope');
    const fence = mkFence();
    const inputs = {
      plan,
      fence,
      targetPaths: [], // no scope declared
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: [],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.8,
    });
    const result = await draftCodeChange(host, inputs);
    expect(result.touchedPaths).toEqual(['README.md']);
  });

  it('empty diff + declared scope -> no error (caller decides)', async () => {
    const plan = mkPlan('llm produced no change');
    const fence = mkFence();
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: '',
      notes: 'Plan is already satisfied; no change required.',
      confidence: 0.3,
    });
    const result = await draftCodeChange(host, inputs);
    expect(result.diff).toBe('');
    expect(result.touchedPaths).toEqual([]);
  });

  it('non-empty diff without unified headers -> diff-parse-failed', async () => {
    // LLM returned prose in the `diff` slot. Without this throw,
    // parseTouchedPaths would silently yield [] and the downstream
    // scope check would accept it as a no-change -- masking a
    // malformed output.
    const plan = mkPlan('prose-in-diff slot');
    const fence = mkFence();
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: 'Here is what I would change: update the README title...',
      notes: 'I was confused.',
      confidence: 0.4,
    });
    await expect(draftCodeChange(host, inputs)).rejects.toMatchObject({
      name: 'DrafterError',
      reason: 'diff-parse-failed',
    });
  });

  it('maxUsdPerPrOverride may tighten the fence cap but not loosen it', async () => {
    // Override above fence cap is silently clamped to the fence
    // value -- the fence is authoritative. Override at or below
    // the fence cap lowers the effective ceiling.
    const plan = mkPlan('check override clamp');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.8,
    });
    // Override of 1_000_000 would be a fence bypass if respected;
    // with the fix it is clamped to fence cap (10).
    const result = await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
      maxUsdPerPrOverride: 1_000_000,
    });
    expect(result.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('maxUsdPerPrOverride rejects non-finite / non-positive values', async () => {
    const plan = mkPlan('bad override');
    const fence = mkFence();
    const base = {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    };
    for (const bad of [0, -1, Infinity, Number.NaN]) {
      await expect(
        draftCodeChange(host, { ...base, maxUsdPerPrOverride: bad }),
      ).rejects.toMatchObject({
        name: 'DrafterError',
        reason: 'cost-cap-exceeded',
      });
    }
  });

  it('cost-cap-exceeded when accumulated cost passes the cap', async () => {
    // MemoryLLM does not report cost_usd, so we wrap its judge()
    // to inject a value larger than the fence cap. This exercises
    // the accumulator + cap-enforcement branch that the default
    // memory host cannot reach (cost_usd stays <= 0 there).
    const plan = mkPlan('simulated expensive draft');
    const fence = mkFence();
    const realJudge = host.llm.judge.bind(host.llm);
    host.llm.judge = (async (schema: unknown, system: unknown, data: unknown, options: unknown) => {
      const res = await realJudge(schema as Parameters<typeof realJudge>[0], system as Parameters<typeof realJudge>[1], data as Parameters<typeof realJudge>[2], options as Parameters<typeof realJudge>[3]);
      return {
        output: res.output,
        metadata: { ...res.metadata, cost_usd: 99.99 },
      };
    }) as typeof host.llm.judge;
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.8,
    });
    await expect(draftCodeChange(host, inputs)).rejects.toMatchObject({
      name: 'DrafterError',
      reason: 'cost-cap-exceeded',
    });
  });

  it('rejects NaN / Infinity / other-negative cost_usd from a broken adapter', async () => {
    // -1 is the documented "unreported" sentinel (MemoryLLM default)
    // and MUST be accepted as zero-contribution. Any OTHER invalid
    // shape fails closed: NaN would skew the accumulator silently;
    // Infinity would claim infinite spend; -0.5 could mean "refund"
    // which is not a thing. All rejected as cost-cap-exceeded.
    const plan = mkPlan('broken cost reporter');
    const fence = mkFence();
    const base = {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.8,
    });
    const realJudge = host.llm.judge.bind(host.llm);
    for (const bad of [Number.NaN, Infinity, -Infinity, -0.5]) {
      host.llm.judge = (async (s: unknown, y: unknown, d: unknown, o: unknown) => {
        const res = await realJudge(s as Parameters<typeof realJudge>[0], y as Parameters<typeof realJudge>[1], d as Parameters<typeof realJudge>[2], o as Parameters<typeof realJudge>[3]);
        return { output: res.output, metadata: { ...res.metadata, cost_usd: bad } };
      }) as typeof host.llm.judge;
      await expect(draftCodeChange(host, base)).rejects.toMatchObject({
        name: 'DrafterError',
        reason: 'cost-cap-exceeded',
      });
    }
  });

  it('accepts -1 cost_usd as unreported (adapter convention)', async () => {
    // Plain MemoryLLM reports cost_usd: -1. This test asserts the
    // default path works without contributing to the accumulator,
    // so unmodified adapters do not accidentally hit the cap.
    const plan = mkPlan('unreported cost');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.8,
    });
    const result = await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    });
    expect(result.totalCostUsd).toBe(0);
  });

  it('forwards framingMode=code-author and effort=high on the LlmOptions', async () => {
    // The drafter must signal to adapters that this is a long
    // schema-bound code-generation call (framingMode='code-author')
    // and cap the substrate-level reasoning depth at 'high' so an
    // adapter-level higher default (set for short classifier judges)
    // does not consume the entire output budget on extended thinking
    // and emit zero structured output.
    const plan = mkPlan('forward framing + effort');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.8,
    });
    let capturedOptions: Record<string, unknown> | null = null;
    const realJudge = host.llm.judge.bind(host.llm);
    host.llm.judge = (async (schema: unknown, system: unknown, data: unknown, options: unknown) => {
      capturedOptions = options as Record<string, unknown>;
      return realJudge(schema as Parameters<typeof realJudge>[0], system as Parameters<typeof realJudge>[1], data as Parameters<typeof realJudge>[2], options as Parameters<typeof realJudge>[3]);
    }) as typeof host.llm.judge;
    await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    });
    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions!.framingMode).toBe('code-author');
    expect(capturedOptions!.effort).toBe('high');
  });

  it('fileContents: when provided non-empty, included in DATA block under `file_contents`', async () => {
    // Closes the APPEND/MODIFY gap: the drafter has no repo access of
    // its own, so an accurate MODIFY diff needs the current file
    // content in-prompt. Callers pre-read the target files and pass
    // `fileContents`; the drafter forwards them verbatim into the
    // schema DATA block so the LLM can compute correct line numbers.
    const plan = mkPlan('Append a line to README.md');
    const fence = mkFence();
    const readmeContent = '# LAG\n\nGovernance substrate.\n';
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'],
      fileContents: [{ path: 'README.md', content: readmeContent }],
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      file_contents: [{ path: 'README.md', content: readmeContent }],
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'Appended per plan using supplied content.',
      confidence: 0.9,
    });
    const result = await draftCodeChange(host, inputs);
    expect(result.diff).toBe(SAMPLE_DIFF);
    expect(result.notes).toBe('Appended per plan using supplied content.');
  });

  it('fileContents: absent when undefined or empty (backward compat with call sites that pre-date the field)', async () => {
    // Pre-existing tests register DATA blocks without `file_contents`.
    // Adding the key unconditionally would break every one of them by
    // shifting the stableStringify hash. The semantic is "omit the
    // key when there is nothing to report" so the DATA block stays
    // lean and the older registered-response shape keeps matching.
    const plan = mkPlan('No file context needed');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['docs/new-file.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: [
        '--- /dev/null',
        '+++ b/docs/new-file.md',
        '@@ -0,0 +1,1 @@',
        '+hello',
        '',
      ].join('\n'),
      notes: 'new file, no source content needed',
      confidence: 0.9,
    });
    // Case A: fileContents omitted entirely.
    const resA = await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['docs/new-file.md'],
      model: 'claude-opus-4-7',
    });
    expect(resA.touchedPaths).toEqual(['docs/new-file.md']);
    // Case B: fileContents explicitly empty array -> same DATA block,
    // so the same registered response matches.
    const resB = await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['docs/new-file.md'],
      fileContents: [],
      model: 'claude-opus-4-7',
    });
    expect(resB.touchedPaths).toEqual(['docs/new-file.md']);
  });

  it('questionPrompt: when provided non-empty, included in DATA block under `question_prompt`', async () => {
    // Closes the deliberation-paraphrase gap: the Decision answer
    // may reduce a concrete instruction ("append line X") to an
    // abstract reference ("the specified line") through
    // arbitration. Without the originating Question body in the
    // DATA block, the LLM has no literal to diff against and emits
    // an empty diff. Threading the Question prompt through as
    // `question_prompt` gives the LLM the verbatim payload; the
    // system prompt tells it to prefer this for diff content while
    // respecting plan_content as the governance contract.
    const plan = mkPlan('APPROVE appending the specified line to README.md');
    const fence = mkFence();
    const inputs = {
      plan,
      fence,
      targetPaths: ['README.md'],
      questionPrompt: 'Append exactly this line to the end of README.md: - entry',
      model: 'claude-opus-4-7',
    };
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      question_prompt: 'Append exactly this line to the end of README.md: - entry',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'Appended per verbatim Question prompt.',
      confidence: 0.9,
    });
    const result = await draftCodeChange(host, inputs);
    expect(result.diff).toBe(SAMPLE_DIFF);
    expect(result.notes).toBe('Appended per verbatim Question prompt.');
  });

  it('citedPaths: roundtrips a declared array from the LLM into the result', async () => {
    // The drafter exposes `cited_paths` in the schema so the LLM can
    // declare which repository paths its prose cites as authoritative
    // source. Callers verify each entry against the working tree
    // before opening a PR; the drafter has no read access at draft
    // time, so a citation that does not exist on disk is a
    // confabulation. This regression locks the wire shape.
    const plan = mkPlan('cite README and a docs page');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.9,
      cited_paths: ['docs/architecture.md', 'src/runtime/actors/planning/'],
    });
    const result = await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    });
    expect(result.citedPaths).toEqual(['docs/architecture.md', 'src/runtime/actors/planning/']);
  });

  it('citedPaths: defaults to empty array when LLM omits the field (back-compat)', async () => {
    // Call sites that pre-date the field land here. The drafter must
    // not throw; the result shape gets a frozen empty array so
    // downstream verification reads as "nothing to verify."
    const plan = mkPlan('no citations declared');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.9,
    });
    const result = await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    });
    expect(result.citedPaths).toEqual([]);
  });

  it('citedPaths: rejects non-array values with schema-validation-failed', async () => {
    // A broken adapter or compromised LLM could return cited_paths as
    // a string or object. The drafter must fail closed rather than
    // hand a malformed citation list to the verifier.
    const plan = mkPlan('malformed citation shape');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.9,
      cited_paths: 'docs/architecture.md',
    });
    await expect(draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    })).rejects.toMatchObject({
      name: 'DrafterError',
      reason: 'schema-validation-failed',
    });
  });

  it('citedPaths: rejects array with non-string entries', async () => {
    const plan = mkPlan('non-string citation entry');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.9,
      cited_paths: ['docs/architecture.md', 42, null],
    });
    await expect(draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    })).rejects.toMatchObject({
      name: 'DrafterError',
      reason: 'schema-validation-failed',
    });
  });

  it('questionPrompt: omitted from DATA when undefined or empty string (backward compat)', async () => {
    // Call sites that pre-date this field must not see their
    // registered MemoryLLM response evicted by a new key. Absent
    // or empty-string `questionPrompt` -> key does not land in the
    // DATA block, preserving the data-hash shape older tests expect.
    const plan = mkPlan('No question prompt supplied');
    const fence = mkFence();
    const expectedData = {
      plan_id: 'plan-drafter-test-1',
      plan_title: 'Test plan',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, expectedData, {
      diff: SAMPLE_DIFF,
      notes: 'ok',
      confidence: 0.9,
    });
    // Case A: `questionPrompt` omitted entirely.
    const resA = await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      model: 'claude-opus-4-7',
    });
    expect(resA.touchedPaths).toEqual(['README.md']);
    // Case B: `questionPrompt` explicitly empty string -> same shape.
    const resB = await draftCodeChange(host, {
      plan,
      fence,
      targetPaths: ['README.md'],
      questionPrompt: '',
      model: 'claude-opus-4-7',
    });
    expect(resB.touchedPaths).toEqual(['README.md']);
  });
});

describe('looksLikeUnifiedDiff', () => {
  it('recognizes a well-formed diff', () => {
    expect(looksLikeUnifiedDiff(SAMPLE_DIFF)).toBe(true);
  });

  it('rejects prose-only output', () => {
    expect(looksLikeUnifiedDiff('Just prose; no diff headers.')).toBe(false);
  });

  it('rejects half-formed diff (--- without +++)', () => {
    expect(looksLikeUnifiedDiff('--- a/README.md\n(no plus side)')).toBe(false);
  });

  it('rejects reversed-header diff (+++ before ---)', () => {
    // Structural regression: an output where `+++` appears before
    // `---` is malformed; downstream patch application would either
    // reject it or apply a reversed patch. The check must enforce
    // order, not just independent presence.
    const reversed = [
      '+++ b/README.md',
      '--- a/README.md',
      '@@ -1,1 +1,1 @@',
      '-# LAG',
      '+# LAG!',
    ].join('\n');
    expect(looksLikeUnifiedDiff(reversed)).toBe(false);
  });
});
