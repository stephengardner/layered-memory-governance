import { describe, it, expect } from 'vitest';
import {
  buildPipelineLifecycle,
  parseCheckCountsFromContent,
  parseLegacyStatusCountsFromContent,
} from './pipeline-lifecycle';
import type { PipelineLifecycleSourceAtom } from './pipeline-lifecycle-types';

/*
 * Unit tests for the pipeline post-dispatch lifecycle projection.
 *
 * Pure-helper tests: feed atoms, assert on the wire shape. No I/O,
 * no time, no globals. Mirrors the test pattern in pipelines.test.ts
 * + plan-state-lifecycle.test.ts.
 */

const NOW = '2026-05-05T13:30:00.000Z';

function atom(
  partial: Partial<PipelineLifecycleSourceAtom> & {
    id: string;
    type: string;
    created_at: string;
  },
): PipelineLifecycleSourceAtom {
  return {
    content: '',
    principal_id: 'cto-actor',
    metadata: {},
    taint: 'clean',
    ...partial,
  };
}

describe('parseCheckCountsFromContent', () => {
  it('returns zero counts for empty / non-matching content', () => {
    expect(parseCheckCountsFromContent('')).toEqual({
      total: 0,
      green: 0,
      red: 0,
      pending: 0,
    });
    expect(parseCheckCountsFromContent('no check rows here')).toEqual({
      total: 0,
      green: 0,
      red: 0,
      pending: 0,
    });
  });

  it('buckets each known github conclusion into the right column', () => {
    const content = [
      'check-runs: 8',
      '  - one: success',
      '  - two: neutral',
      '  - three: skipped',
      '  - four: failure',
      '  - five: cancelled',
      '  - six: action_required',
      '  - seven: queued',
      '  - eight: in_progress',
    ].join('\n');
    expect(parseCheckCountsFromContent(content)).toEqual({
      total: 8,
      green: 3,
      red: 3,
      pending: 2,
    });
  });

  it('treats unrecognized states as pending (loud-fail fallback, not silent green)', () => {
    const content = [
      'check-runs: 2',
      '  - some: future_state_we_have_not_seen',
      '  - other: another_unknown',
    ].join('\n');
    const counts = parseCheckCountsFromContent(content);
    expect(counts.total).toBe(2);
    expect(counts.green).toBe(0);
    expect(counts.red).toBe(0);
    expect(counts.pending).toBe(2);
  });

  it('does NOT count bullets that appear OUTSIDE the check-runs block', () => {
    /*
     * Regression: an earlier shape of the parser matched any indented
     * `- name: state` line anywhere in the content, which inflated
     * counts when other sections (legacy statuses, future bullet
     * groups) appeared. The parser must scope strictly to bullets
     * AFTER `check-runs:` and BEFORE the next top-level header.
     */
    const content = [
      'check-runs: 2',
      '  - first: success',
      '  - second: success',
      'legacy statuses: 3',
      '  - bogus_first: failure',
      '  - bogus_second: failure',
      '  - bogus_third: failure',
      'unresolved line comments: 0',
    ].join('\n');
    const counts = parseCheckCountsFromContent(content);
    expect(counts.total).toBe(2);
    expect(counts.green).toBe(2);
    expect(counts.red).toBe(0);
    expect(counts.pending).toBe(0);
  });

  it('returns zero when content has no check-runs header', () => {
    /*
     * If the substrate emits only legacy-statuses bullets without a
     * check-runs section, the parser MUST return 0 (no checks to
     * count) rather than counting the legacy bullets. Defends against
     * the "any bullet anywhere" anti-shape.
     */
    const content = [
      'legacy statuses: 1',
      '  - CodeRabbit: failure',
    ].join('\n');
    const counts = parseCheckCountsFromContent(content);
    expect(counts.total).toBe(0);
    expect(counts.red).toBe(0);
  });

  it('matches the real-world content shape the runner emits', () => {
    // Verbatim shape from a recent pr-observation atom in this repo.
    const content = [
      '**pr-observation for owner/repo#312**',
      '',
      'observed_at: 2026-05-05T13:12:19.791Z',
      'mergeable: true',
      'mergeStateStatus: `BLOCKED`',
      '',
      'submitted reviews: 0',
      'check-runs: 17',
      '  - LAG-auditor (noop): skipped',
      '  - pr-landing agent: queued',
      '  - LAG auditor gate: queued',
      '  - LAG-auditor (noop): skipped',
      '  - LAG auditor gate: cancelled',
      '  - pr-landing agent: cancelled',
      '  - typecheck + build + lint: queued',
      '  - LAG auditor gate: skipped',
      '  - package hygiene: queued',
      '  - Node 22 on ubuntu-latest: in_progress',
      '  - Node 22 on windows-latest: in_progress',
      '  - pr-landing agent: cancelled',
      '  - LAG-auditor (noop): cancelled',
      '  - cr-precheck: queued',
      '  - Analyze (actions): queued',
      '  - Analyze (python): queued',
      '  - Analyze (javascript-typescript): in_progress',
      'legacy statuses: 0',
    ].join('\n');
    const counts = parseCheckCountsFromContent(content);
    expect(counts.total).toBe(17);
    // 3 skipped -> green; 4 cancelled -> red; 10 queued/in_progress -> pending.
    expect(counts.green).toBe(3);
    expect(counts.red).toBe(4);
    expect(counts.pending).toBe(10);
  });
});

describe('parseLegacyStatusCountsFromContent', () => {
  it('returns zero counts for empty input', () => {
    expect(parseLegacyStatusCountsFromContent('')).toEqual({ total: 0, red: 0 });
  });

  it('counts red conclusions only inside the legacy-statuses block', () => {
    const content = [
      'check-runs: 1',
      '  - irrelevant: failure',
      'legacy statuses: 2',
      '  - CodeRabbit: success',
      '  - other: failure',
      'unresolved line comments: 0',
    ].join('\n');
    const counts = parseLegacyStatusCountsFromContent(content);
    expect(counts.total).toBe(2);
    expect(counts.red).toBe(1);
  });

  it('treats `error`, `cancelled`, `timed_out`, `action_required` as red', () => {
    /*
     * Red bucket aligned with parseCheckCountsFromContent: any
     * GitHub conclusion that fails a merge gate counts. Drift
     * between the two parsers would silently mislead the verdict
     * ladder when a legacy CodeRabbit status `timed_out` (which is
     * a real CI-side state) lands.
     */
    const content = [
      'legacy statuses: 4',
      '  - first: error',
      '  - second: cancelled',
      '  - third: timed_out',
      '  - fourth: action_required',
    ].join('\n');
    const counts = parseLegacyStatusCountsFromContent(content);
    expect(counts.total).toBe(4);
    expect(counts.red).toBe(4);
  });

  it('returns zero when content has no legacy-statuses header', () => {
    const content = [
      'check-runs: 1',
      '  - one: failure',
    ].join('\n');
    expect(parseLegacyStatusCountsFromContent(content)).toEqual({ total: 0, red: 0 });
  });
});

describe('buildPipelineLifecycle: empty', () => {
  it('returns all-null fields when no atoms reference the pipeline', () => {
    const result = buildPipelineLifecycle([], 'pipeline-missing');
    expect(result.pipeline_id).toBe('pipeline-missing');
    expect(result.plan_id).toBeNull();
    expect(result.dispatch_record).toBeNull();
    expect(result.code_author_invoked).toBeNull();
    expect(result.observation).toBeNull();
    expect(result.merge).toBeNull();
  });
});

describe('buildPipelineLifecycle: dispatch-record only', () => {
  it('surfaces scanned/dispatched/failed/cost from dispatch-record metadata', () => {
    const dispatch = atom({
      id: 'dispatch-record-pipeline-test-1',
      type: 'dispatch-record',
      created_at: NOW,
      content: '{}',
      metadata: {
        pipeline_id: 'pipeline-test-1',
        stage_name: 'dispatch-stage',
        stage_output: {
          dispatch_status: 'completed',
          scanned: 1,
          dispatched: 1,
          failed: 0,
          cost_usd: 0,
        },
      },
    });
    const result = buildPipelineLifecycle([dispatch], 'pipeline-test-1');
    expect(result.dispatch_record).not.toBeNull();
    expect(result.dispatch_record?.scanned).toBe(1);
    expect(result.dispatch_record?.dispatched).toBe(1);
    expect(result.dispatch_record?.failed).toBe(0);
    expect(result.dispatch_record?.dispatch_status).toBe('completed');
    expect(result.dispatch_record?.error_message).toBeNull();
    expect(result.dispatch_record?.atom_id).toBe('dispatch-record-pipeline-test-1');
  });

  it('skips tainted dispatch-record atoms', () => {
    const dispatch = atom({
      id: 'dispatch-record-pipeline-test-2',
      type: 'dispatch-record',
      created_at: NOW,
      taint: 'compromised',
      metadata: {
        pipeline_id: 'pipeline-test-2',
        stage_output: { dispatch_status: 'completed', scanned: 1, dispatched: 1, failed: 0, cost_usd: 0 },
      },
    });
    const result = buildPipelineLifecycle([dispatch], 'pipeline-test-2');
    expect(result.dispatch_record).toBeNull();
  });

  it('skips superseded dispatch-record atoms', () => {
    const dispatch = atom({
      id: 'dispatch-record-pipeline-test-3',
      type: 'dispatch-record',
      created_at: NOW,
      superseded_by: ['dispatch-record-pipeline-test-3-v2'],
      metadata: {
        pipeline_id: 'pipeline-test-3',
        stage_output: { dispatch_status: 'completed', scanned: 1, dispatched: 1, failed: 0, cost_usd: 0 },
      },
    });
    const result = buildPipelineLifecycle([dispatch], 'pipeline-test-3');
    expect(result.dispatch_record).toBeNull();
  });
});

describe('buildPipelineLifecycle: dispatch failure surfaces error_message', () => {
  it('pulls error_message from plan metadata.dispatch_result when failed > 0', () => {
    const plan = atom({
      id: 'plan-dogfeed-cto-actor-pipeline-test-4-0',
      type: 'plan',
      created_at: NOW,
      metadata: {
        pipeline_id: 'pipeline-test-4',
        dispatch_result: {
          kind: 'error',
          stage: 'apply-branch/diff-apply-failed',
          message: 'git apply --check rejected the diff',
          at: NOW,
        },
      },
    });
    const dispatch = atom({
      id: 'dispatch-record-pipeline-test-4',
      type: 'dispatch-record',
      created_at: NOW,
      metadata: {
        pipeline_id: 'pipeline-test-4',
        stage_output: { dispatch_status: 'completed', scanned: 1, dispatched: 0, failed: 1, cost_usd: 0 },
      },
    });
    const result = buildPipelineLifecycle([plan, dispatch], 'pipeline-test-4');
    expect(result.dispatch_record?.failed).toBe(1);
    expect(result.dispatch_record?.error_message).toBe('git apply --check rejected the diff');
    expect(result.plan_id).toBe('plan-dogfeed-cto-actor-pipeline-test-4-0');
  });
});

describe('buildPipelineLifecycle: code-author-invoked', () => {
  it('surfaces dispatched executor result with PR ref', () => {
    const plan = atom({
      id: 'plan-feat-cto-actor-pipeline-test-5-0',
      type: 'plan',
      created_at: NOW,
      metadata: { pipeline_id: 'pipeline-test-5' },
    });
    const invoked = atom({
      id: 'code-author-invoked-plan-feat-pipeline-test-5-0',
      type: 'observation',
      created_at: NOW,
      metadata: {
        kind: 'code-author-invoked',
        plan_id: 'plan-feat-cto-actor-pipeline-test-5-0',
        correlation_id: 'dispatch-plan-feat-cto-actor-pipeline-test-5-0',
        executor_result: {
          kind: 'dispatched',
          pr_number: 312,
          pr_html_url: 'https://github.com/owner/repo/pull/312',
          branch_name: 'code-author/plan-feat-pipeline-test-5-0',
          commit_sha: '8400e95fb689366ebd0073608d0f9c649467fcf7',
        },
      },
    });
    const result = buildPipelineLifecycle([plan, invoked], 'pipeline-test-5');
    expect(result.code_author_invoked?.kind).toBe('dispatched');
    expect(result.code_author_invoked?.pr_number).toBe(312);
    expect(result.code_author_invoked?.pr_html_url).toBe('https://github.com/owner/repo/pull/312');
    expect(result.code_author_invoked?.branch_name).toBe('code-author/plan-feat-pipeline-test-5-0');
    expect(result.code_author_invoked?.commit_sha).toBe('8400e95fb689366ebd0073608d0f9c649467fcf7');
    expect(result.code_author_invoked?.reason).toBeNull();
    expect(result.code_author_invoked?.stage).toBeNull();
  });

  it('surfaces error executor result with reason + stage on silent-skip', () => {
    const plan = atom({
      id: 'plan-feat-cto-actor-pipeline-test-6-0',
      type: 'plan',
      created_at: NOW,
      metadata: { pipeline_id: 'pipeline-test-6' },
    });
    const invoked = atom({
      id: 'code-author-invoked-plan-feat-pipeline-test-6-0',
      type: 'observation',
      created_at: NOW,
      metadata: {
        kind: 'code-author-invoked',
        plan_id: 'plan-feat-cto-actor-pipeline-test-6-0',
        correlation_id: 'dispatch-plan-feat-cto-actor-pipeline-test-6-0',
        executor_result: {
          kind: 'error',
          stage: 'apply-branch/diff-apply-failed',
          reason: 'git apply --check rejected the diff',
        },
      },
    });
    const result = buildPipelineLifecycle([plan, invoked], 'pipeline-test-6');
    expect(result.code_author_invoked?.kind).toBe('error');
    expect(result.code_author_invoked?.pr_number).toBeNull();
    expect(result.code_author_invoked?.reason).toBe('git apply --check rejected the diff');
    expect(result.code_author_invoked?.stage).toBe('apply-branch/diff-apply-failed');
  });

  it('rejects observation atoms whose kind is a non-code-author *-invoked variant', () => {
    /*
     * The pickCodeAuthorInvoked filter MUST be strict on kind. A
     * future actor (pr-fix, drafter, etc.) may write an atom with
     * `kind: 'pr-fix-invoked'` against the same plan; if our loose
     * `*-invoked` glob accepted it, the lifecycle row would silently
     * surface the wrong executor's result and mislead the operator
     * about which sub-actor opened the PR.
     */
    const plan = atom({
      id: 'plan-feat-cto-actor-pipeline-strict-kind-0',
      type: 'plan',
      created_at: NOW,
      metadata: { pipeline_id: 'pipeline-strict-kind' },
    });
    const wrongKind = atom({
      id: 'pr-fix-invoked-plan-feat-strict-kind-0',
      type: 'observation',
      created_at: NOW,
      metadata: {
        kind: 'pr-fix-invoked',
        plan_id: 'plan-feat-cto-actor-pipeline-strict-kind-0',
        executor_result: { kind: 'dispatched', pr_number: 999 },
      },
    });
    const result = buildPipelineLifecycle([plan, wrongKind], 'pipeline-strict-kind');
    expect(result.code_author_invoked).toBeNull();
  });

  it('picks the most recent invocation when a plan was re-dispatched', () => {
    const plan = atom({
      id: 'plan-feat-cto-actor-pipeline-test-7-0',
      type: 'plan',
      created_at: '2026-05-05T13:00:00.000Z',
      metadata: { pipeline_id: 'pipeline-test-7' },
    });
    const earlier = atom({
      id: 'code-author-invoked-plan-feat-pipeline-test-7-earlier',
      type: 'observation',
      created_at: '2026-05-05T13:10:00.000Z',
      metadata: {
        kind: 'code-author-invoked',
        plan_id: 'plan-feat-cto-actor-pipeline-test-7-0',
        executor_result: {
          kind: 'error',
          stage: 'apply-branch/diff-apply-failed',
          reason: 'first attempt failed',
        },
      },
    });
    const later = atom({
      id: 'code-author-invoked-plan-feat-pipeline-test-7-later',
      type: 'observation',
      created_at: '2026-05-05T13:20:00.000Z',
      metadata: {
        kind: 'code-author-invoked',
        plan_id: 'plan-feat-cto-actor-pipeline-test-7-0',
        executor_result: {
          kind: 'dispatched',
          pr_number: 999,
          pr_html_url: 'https://github.com/owner/repo/pull/999',
        },
      },
    });
    const result = buildPipelineLifecycle([plan, earlier, later], 'pipeline-test-7');
    expect(result.code_author_invoked?.atom_id).toBe('code-author-invoked-plan-feat-pipeline-test-7-later');
    expect(result.code_author_invoked?.pr_number).toBe(999);
  });
});

describe('buildPipelineLifecycle: pr-observation + merge', () => {
  const plan = atom({
    id: 'plan-feat-cto-actor-pipeline-test-8-0',
    type: 'plan',
    created_at: NOW,
    metadata: { pipeline_id: 'pipeline-test-8' },
  });

  it('surfaces legacy_statuses + legacy_statuses_red parsed from the observation content', () => {
    /*
     * The legacy-statuses surface is load-bearing because the
     * `CodeRabbit` legacy status posts there; canon
     * dev-multi-surface-review-observation requires reading it.
     * Assert that the projection lifts the parsed-from-content red
     * count + the metadata-reported total into the observation block,
     * AND that the check-runs counts do not leak from the legacy
     * bullets (regression coverage for the "any bullet" parser bug).
     */
    const obs = atom({
      id: 'pr-observation-with-legacy-failure',
      type: 'observation',
      created_at: NOW,
      content: [
        'check-runs: 1',
        '  - whatever: success',
        'legacy statuses: 1',
        '  - CodeRabbit: failure',
        'unresolved line comments: 0',
      ].join('\n'),
      metadata: {
        kind: 'pr-observation',
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        head_sha: 'sha2',
        observed_at: NOW,
        pr_state: 'OPEN',
        merge_state_status: 'BLOCKED',
        counts: {
          line_comments: 0,
          body_nits: 0,
          submitted_reviews: 0,
          check_runs: 1,
          legacy_statuses: 1,
        },
      },
    });
    const result = buildPipelineLifecycle([plan, obs], 'pipeline-test-8');
    expect(result.observation?.legacy_statuses).toBe(1);
    expect(result.observation?.legacy_statuses_red).toBe(1);
    // check_counts should reflect ONLY the check-runs section, not
    // the legacy-status bullet that appears below it.
    expect(result.observation?.check_counts.total).toBe(1);
    expect(result.observation?.check_counts.green).toBe(1);
    expect(result.observation?.check_counts.red).toBe(0);
  });

  it('surfaces the latest pr-observation snapshot with parsed check counts', () => {
    const obs = atom({
      id: 'pr-observation-owner-repo-312-abc',
      type: 'observation',
      created_at: NOW,
      content: [
        'pr-observation for owner/repo#312',
        'mergeStateStatus: `BLOCKED`',
        'submitted reviews: 1',
        'check-runs: 4',
        '  - first: success',
        '  - second: success',
        '  - third: failure',
        '  - fourth: in_progress',
      ].join('\n'),
      metadata: {
        kind: 'pr-observation',
        pr: { owner: 'owner', repo: 'repo', number: 312 },
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        head_sha: 'sha1',
        observed_at: NOW,
        mergeable: true,
        merge_state_status: 'BLOCKED',
        pr_state: 'OPEN',
        pr_title: 'feat: a PR',
        counts: {
          line_comments: 0,
          body_nits: 0,
          submitted_reviews: 1,
          check_runs: 4,
          legacy_statuses: 0,
        },
      },
    });
    const result = buildPipelineLifecycle([plan, obs], 'pipeline-test-8');
    expect(result.observation?.pr_number).toBe(312);
    expect(result.observation?.pr_state).toBe('OPEN');
    expect(result.observation?.merge_state_status).toBe('BLOCKED');
    expect(result.observation?.mergeable).toBe(true);
    expect(result.observation?.submitted_reviews).toBe(1);
    expect(result.observation?.check_counts.green).toBe(2);
    expect(result.observation?.check_counts.red).toBe(1);
    expect(result.observation?.check_counts.pending).toBe(1);
  });

  it('surfaces a merge block from plan-merge-settled', () => {
    const obs = atom({
      id: 'pr-observation-owner-repo-312-merged',
      type: 'observation',
      created_at: NOW,
      content: 'check-runs: 0',
      metadata: {
        kind: 'pr-observation',
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        head_sha: 'sha1',
        pr_state: 'MERGED',
        merge_state_status: 'CLEAN',
        observed_at: NOW,
        counts: { line_comments: 0, body_nits: 0, submitted_reviews: 0, check_runs: 0, legacy_statuses: 0 },
      },
    });
    const settled = atom({
      id: 'plan-merge-settled-abc',
      type: 'plan-merge-settled',
      created_at: NOW,
      principal_id: 'pr-landing-agent',
      metadata: {
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        pr_state: 'MERGED',
        target_plan_state: 'succeeded',
        settled_at: NOW,
      },
    });
    const result = buildPipelineLifecycle([plan, obs, settled], 'pipeline-test-8');
    expect(result.merge?.atom_id).toBe('plan-merge-settled-abc');
    expect(result.merge?.target_plan_state).toBe('succeeded');
    expect(result.merge?.merger_principal_id).toBe('pr-landing-agent');
    expect(result.merge?.pr_state).toBe('MERGED');
  });

  it('lifts merge_commit_sha from the settled atom when present', () => {
    const obs = atom({
      id: 'pr-observation-with-head-sha',
      type: 'observation',
      created_at: NOW,
      content: 'check-runs: 0',
      metadata: {
        kind: 'pr-observation',
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        head_sha: 'observation-sha',
        pr_state: 'MERGED',
        merge_state_status: 'CLEAN',
        observed_at: NOW,
        counts: { line_comments: 0, body_nits: 0, submitted_reviews: 0, check_runs: 0, legacy_statuses: 0 },
      },
    });
    const settled = atom({
      id: 'plan-merge-settled-with-commit',
      type: 'plan-merge-settled',
      created_at: NOW,
      principal_id: 'pr-landing-agent',
      metadata: {
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        pr_state: 'MERGED',
        target_plan_state: 'succeeded',
        settled_at: NOW,
        merge_commit_sha: 'settled-commit-sha',
      },
    });
    const result = buildPipelineLifecycle([plan, obs, settled], 'pipeline-test-8');
    // Settled atom's merge_commit_sha wins when present.
    expect(result.merge?.merge_commit_sha).toBe('settled-commit-sha');
  });

  it('falls back to observation head_sha when settled atom has no commit', () => {
    const obs = atom({
      id: 'pr-observation-with-head-fallback',
      type: 'observation',
      created_at: NOW,
      content: 'check-runs: 0',
      metadata: {
        kind: 'pr-observation',
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        head_sha: 'observation-fallback-sha',
        pr_state: 'MERGED',
        merge_state_status: 'CLEAN',
        observed_at: NOW,
        counts: { line_comments: 0, body_nits: 0, submitted_reviews: 0, check_runs: 0, legacy_statuses: 0 },
      },
    });
    const settled = atom({
      id: 'plan-merge-settled-no-commit',
      type: 'plan-merge-settled',
      created_at: NOW,
      principal_id: 'pr-landing-agent',
      metadata: {
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        pr_state: 'MERGED',
        target_plan_state: 'succeeded',
        settled_at: NOW,
        // No merge_commit_sha on the settled atom; UI must fall back
        // to the observation's head_sha so the merged commit is still
        // visible. Earlier shape returned null here, losing the
        // operator-relevant identifier on every settled merge.
      },
    });
    const result = buildPipelineLifecycle([plan, obs, settled], 'pipeline-test-8');
    expect(result.merge?.merge_commit_sha).toBe('observation-fallback-sha');
  });

  it('synthesizes a merge block from pr-observation when plan-merge-settled is absent', () => {
    const obs = atom({
      id: 'pr-observation-owner-repo-312-merged-only',
      type: 'observation',
      created_at: NOW,
      content: 'check-runs: 0',
      metadata: {
        kind: 'pr-observation',
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        head_sha: 'merge-commit-sha',
        pr_state: 'MERGED',
        merge_state_status: 'CLEAN',
        observed_at: NOW,
        counts: { line_comments: 0, body_nits: 0, submitted_reviews: 0, check_runs: 0, legacy_statuses: 0 },
      },
    });
    const result = buildPipelineLifecycle([plan, obs], 'pipeline-test-8');
    // No plan-merge-settled atom; merge block is synthesized from the
    // observation so the UI doesn't lose the merged-but-not-yet-reconciled
    // state during the reconciler's lag window.
    expect(result.merge).not.toBeNull();
    expect(result.merge?.atom_id).toBeNull();
    expect(result.merge?.merge_commit_sha).toBe('merge-commit-sha');
    expect(result.merge?.merger_principal_id).toBeNull();
  });

  it('does NOT synthesize merge when pr_state is OPEN', () => {
    const obs = atom({
      id: 'pr-observation-open-pr',
      type: 'observation',
      created_at: NOW,
      content: 'check-runs: 0',
      metadata: {
        kind: 'pr-observation',
        plan_id: 'plan-feat-cto-actor-pipeline-test-8-0',
        pr_state: 'OPEN',
        merge_state_status: 'BLOCKED',
        head_sha: 'sha1',
        observed_at: NOW,
        counts: { line_comments: 0, body_nits: 0, submitted_reviews: 0, check_runs: 0, legacy_statuses: 0 },
      },
    });
    const result = buildPipelineLifecycle([plan, obs], 'pipeline-test-8');
    expect(result.merge).toBeNull();
  });
});

describe('buildPipelineLifecycle: full chain', () => {
  it('stitches the full pipeline -> dispatch -> code-author -> observation -> merge chain', () => {
    const pipelineId = 'pipeline-cto-1777986208211-f7ng3d';
    const planId = 'plan-add-pinned-plans-cto-actor-pipeline-cto-1777986208211-f7ng3d-0';
    const plan = atom({
      id: planId,
      type: 'plan',
      created_at: '2026-05-05T13:08:28.349Z',
      metadata: { pipeline_id: pipelineId, title: 'pin pins' },
    });
    const dispatch = atom({
      id: `dispatch-record-${pipelineId}-dispatch-stage`,
      type: 'dispatch-record',
      created_at: '2026-05-05T13:12:25.268Z',
      metadata: {
        pipeline_id: pipelineId,
        stage_output: { dispatch_status: 'completed', scanned: 1, dispatched: 1, failed: 0, cost_usd: 0 },
      },
    });
    const invoked = atom({
      id: `code-author-invoked-${planId}-2026-05-05`,
      type: 'observation',
      created_at: '2026-05-05T13:08:34.516Z',
      metadata: {
        kind: 'code-author-invoked',
        plan_id: planId,
        correlation_id: `dispatch-${planId}`,
        executor_result: {
          kind: 'dispatched',
          pr_number: 312,
          pr_html_url: 'https://github.com/stephengardner/layered-autonomous-governance/pull/312',
          branch_name: 'code-author/plan-add-pinned-plans-cto-actor-pipeline-cto-1777986208211-f7ng3d-0-1ff6ed',
          commit_sha: '8400e95fb689366ebd0073608d0f9c649467fcf7',
        },
      },
    });
    const obs = atom({
      id: 'pr-observation-stephengardner-layered-autonomous-governance-312-8400e95fb689',
      type: 'observation',
      created_at: '2026-05-05T13:12:19.791Z',
      content: 'check-runs: 2\n  - one: success\n  - two: success',
      metadata: {
        kind: 'pr-observation',
        pr: { owner: 'stephengardner', repo: 'layered-autonomous-governance', number: 312 },
        plan_id: planId,
        head_sha: '8400e95fb689366ebd0073608d0f9c649467fcf7',
        observed_at: '2026-05-05T13:12:19.791Z',
        mergeable: true,
        merge_state_status: 'CLEAN',
        pr_state: 'MERGED',
        pr_title: 'feat: pinned plans',
        counts: { line_comments: 0, body_nits: 0, submitted_reviews: 1, check_runs: 2, legacy_statuses: 0 },
      },
    });
    const settled = atom({
      id: 'plan-merge-settled-pinned-plans',
      type: 'plan-merge-settled',
      created_at: '2026-05-05T13:13:00.000Z',
      principal_id: 'pr-landing-agent',
      metadata: {
        plan_id: planId,
        pr_state: 'MERGED',
        target_plan_state: 'succeeded',
        settled_at: '2026-05-05T13:13:00.000Z',
      },
    });
    const result = buildPipelineLifecycle([plan, dispatch, invoked, obs, settled], pipelineId);
    expect(result.pipeline_id).toBe(pipelineId);
    expect(result.plan_id).toBe(planId);
    expect(result.dispatch_record?.dispatched).toBe(1);
    expect(result.code_author_invoked?.pr_number).toBe(312);
    expect(result.observation?.pr_state).toBe('MERGED');
    expect(result.observation?.check_counts.green).toBe(2);
    expect(result.merge?.target_plan_state).toBe('succeeded');
    expect(result.merge?.merger_principal_id).toBe('pr-landing-agent');
  });
});
