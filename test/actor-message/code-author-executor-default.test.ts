/**
 * Unit tests for buildDefaultCodeAuthorExecutor.
 *
 * Exercises the composition of drafter + git-ops + pr-creation with
 * every external system stubbed:
 *   - LLM via MemoryLLM fingerprint-registered responses
 *   - git via injected execImpl (no subprocess)
 *   - GitHub via injected GhClient.rest
 *
 * Coverage:
 *   - happy path: dispatched result with PR handle + cost + confidence
 *   - drafter failure (unregistered LLM call) -> stage drafter/llm-call-failed
 *   - apply-branch failure (dirty worktree) -> stage apply-branch/dirty-worktree
 *   - pr-creation failure (gh-api) -> stage pr-creation/gh-api-failed
 *   - commit message carries plan title + draft notes
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { execa } from 'execa';
import { createMemoryHost, type MemoryHost } from '../../src/adapters/memory/index.js';
import type { Atom, AtomId, PrincipalId, Time } from '../../src/substrate/types.js';
import type { GhClient } from '../../src/external/github/index.js';
import { buildDefaultCodeAuthorExecutor } from '../../src/actor-message/executor-default.js';
import {
  DRAFT_SCHEMA,
  DRAFT_SYSTEM_PROMPT,
} from '../../src/actors/code-author/drafter.js';
import type { CodeAuthorFence } from '../../src/actors/code-author/fence.js';

const BOOT_TIME = '2026-04-21T00:00:00.000Z' as Time;

function mkFence(): CodeAuthorFence {
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
  });
}

function mkPlan(id: string, content: string, meta: Record<string, unknown> = {}): Atom {
  return {
    schema_version: 1,
    id: id as AtomId,
    content,
    type: 'plan',
    layer: 'L1',
    provenance: {
      kind: 'agent-observed',
      source: { agent_id: 'cto-actor', session_id: 'test' },
      derived_from: [],
    },
    confidence: 0.85,
    created_at: BOOT_TIME,
    last_reinforced_at: BOOT_TIME,
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
    metadata: { title: 'Bump README', ...meta },
  };
}

const VALID_DIFF = [
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,1 +1,1 @@',
  '-# LAG',
  '+# LAG!',
  '',
].join('\n');

function ghClientStub(restImpl: GhClient['rest']): GhClient {
  return {
    rest: restImpl,
    graphql: (async () => { throw new Error('graphql not stubbed'); }) as GhClient['graphql'],
    raw: (async () => { throw new Error('raw not stubbed'); }) as GhClient['raw'],
  };
}

interface StubReply { exitCode: number; stdout?: string; stderr?: string }

function stubGitExeca(replies: ReadonlyArray<StubReply>) {
  const calls: Array<{ args: ReadonlyArray<string>; input?: string }> = [];
  let i = 0;
  const impl = (async (_bin: string, args: ReadonlyArray<string>, options: Record<string, unknown>) => {
    calls.push({ args: args.slice(), ...(options['input'] !== undefined ? { input: options['input'] as string } : {}) });
    const r = replies[i++];
    if (!r) throw new Error(`stubGitExeca: no reply for call #${i}; args=${args.join(' ')}`);
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  }) as unknown as typeof execa;
  return { impl, calls };
}

const GIT_HAPPY_REPLIES: ReadonlyArray<StubReply> = [
  { exitCode: 0 },
  { exitCode: 0 },
  { exitCode: 0 },
  { exitCode: 0 },
  { exitCode: 0 },
  { exitCode: 0 },
  { exitCode: 0 },
  { exitCode: 0, stdout: 'deadbeefcafe0011223344556677889900aabbcc\n' },
  { exitCode: 0 },
];

function registerDrafterResponse(
  host: MemoryHost,
  plan: Atom,
  targetPaths: ReadonlyArray<string>,
  response: { diff: string; notes: string; confidence: number },
  successCriteria = '',
): void {
  const data = {
    plan_id: String(plan.id),
    plan_title: typeof plan.metadata['title'] === 'string' ? plan.metadata['title'] as string : '(untitled)',
    plan_content: plan.content,
    target_paths: targetPaths.slice(),
    success_criteria: successCriteria,
    fence_snapshot: {
      max_usd_per_pr: 10,
      required_checks: ['Node 22 on ubuntu-latest'],
    },
  };
  host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, response);
}

describe('buildDefaultCodeAuthorExecutor', () => {
  let host: MemoryHost;

  beforeEach(() => {
    host = createMemoryHost();
  });

  it('happy path: composes drafter + git-ops + pr-creation -> dispatched', async () => {
    const plan = mkPlan('plan-happy', '# Test plan\n\nFix a small thing.', {
      target_paths: ['README.md'],
      title: 'Bump README title',
    });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'Bumped the README title.',
      confidence: 0.92,
    });

    const { impl: execImpl, calls: gitCalls } = stubGitExeca(GIT_HAPPY_REPLIES);

    const prFields: Array<Record<string, unknown>> = [];
    const ghClient = ghClientStub((async (args: Record<string, unknown>) => {
      prFields.push(args);
      return {
        number: 101,
        html_url: 'https://github.com/o/r/pull/101',
        url: 'https://api.github.com/repos/o/r/pulls/101',
        node_id: 'PR_kw',
        state: 'open',
      };
    }) as GhClient['rest']);

    const executor = buildDefaultCodeAuthorExecutor({
      host,
      ghClient,
      owner: 'o',
      repo: 'r',
      repoDir: '/tmp/repo-stub',
      gitIdentity: { name: 'Code Author', email: 'code-author@example.com' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc123',
      execImpl,
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'corr-1', observationAtomId: 'obs-test' as AtomId });

    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.prNumber).toBe(101);
    expect(result.prHtmlUrl).toBe('https://github.com/o/r/pull/101');
    expect(result.branchName).toBe('code-author/plan-happy-abc123');
    expect(result.commitSha).toBe('deadbeefcafe0011223344556677889900aabbcc');
    expect(result.confidence).toBeCloseTo(0.92);
    expect(result.modelUsed).toBe('claude-opus-4-7');
    expect(result.touchedPaths).toEqual(['README.md']);

    expect(gitCalls).toHaveLength(9);
    expect(prFields).toHaveLength(1);

    const prArgs = prFields[0]!;
    expect(prArgs['method']).toBe('POST');
    expect(prArgs['path']).toBe('repos/o/r/pulls');
    const body = (prArgs['fields'] as Record<string, unknown>)['body'] as string;
    expect(body).toContain('Bumped the README title.');
    expect(body).toContain('"plan-happy"');
    expect(body).toContain('"deadbeefcafe0011223344556677889900aabbcc"');
    const title = (prArgs['fields'] as Record<string, unknown>)['title'] as string;
    expect(title).toBe('code-author: Bump README title');
  });

  it('drafter LLM failure -> stage drafter/llm-call-failed', async () => {
    // No response registered; MemoryLLM throws UnsupportedError which
    // the drafter wraps as DrafterError(llm-call-failed).
    const plan = mkPlan('plan-no-response', 'unregistered', { target_paths: ['README.md'] });

    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDefaultCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'corr-1', observationAtomId: 'obs-test' as AtomId });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('drafter/llm-call-failed');
  });

  it('git-ops dirty worktree -> stage apply-branch/dirty-worktree', async () => {
    const plan = mkPlan('plan-dirty', '# plan\n\ncontent', { target_paths: ['README.md'] });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'ok',
      confidence: 0.9,
    });

    const { impl: execImpl } = stubGitExeca([
      { exitCode: 0, stdout: ' M src/foo.ts\n' }, // dirty
    ]);
    const executor = buildDefaultCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'corr-1', observationAtomId: 'obs-test' as AtomId });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('apply-branch/dirty-worktree');
  });

  it('pr-creation gh-api failure -> stage pr-creation/gh-api-failed', async () => {
    const plan = mkPlan('plan-pr-fail', '# plan\n\ncontent', { target_paths: ['README.md'] });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'ok',
      confidence: 0.9,
    });

    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDefaultCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => { throw new Error('gh boom'); }) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'corr-1', observationAtomId: 'obs-test' as AtomId });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('pr-creation/gh-api-failed');
    expect(result.reason).toMatch(/gh boom/);
  });

  it('plan id with unsafe git-ref chars is sanitized in branch name', async () => {
    // Git ref-name rules reject `:`, whitespace, `..`, `~`, `^`,
    // and a handful of others. A plan id is not required to obey
    // those rules; the executor must sanitize before branch create
    // or the `git checkout -b` step fails loud.
    const plan = mkPlan('plan:with bad/chars?and~more', '# plan\n\ncontent', {
      target_paths: ['README.md'],
    });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'ok',
      confidence: 0.9,
    }, '');
    const { impl: execImpl, calls: gitCalls } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDefaultCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({ number: 1, html_url: '', url: '', node_id: '', state: 'open' })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'nonce1',
      execImpl,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-id-1' as AtomId });
    if (result.kind !== 'dispatched') throw new Error('expected dispatched');
    // Branch name must contain no forbidden chars; specifically no
    // `:`, `?`, or whitespace from the raw plan id.
    expect(result.branchName).not.toMatch(/[:?~\s]/);
    expect(result.branchName).toMatch(/^code-author\/plan-with-bad\/chars-and-more-nonce1$/);
    // And the checkout -b call must use the sanitized name.
    const checkoutCall = gitCalls.find((c) => c.args.includes('checkout') && c.args.includes('-b'));
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall!.args).toContain(result.branchName);
  });

  it('observationAtomId from invoker is threaded into PR body footer (not a placeholder)', async () => {
    const plan = mkPlan('plan-threaded', '# plan\n\ncontent', {
      target_paths: ['README.md'],
    });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'ok',
      confidence: 0.9,
    }, '');
    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const prFields: Array<Record<string, unknown>> = [];
    const executor = buildDefaultCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async (args: Record<string, unknown>) => {
        prFields.push(args);
        return { number: 1, html_url: '', url: '', node_id: '', state: 'open' };
      }) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
    });
    // The caller (invoker) passes the REAL atom id, which includes
    // timestamp + nonce components. Previously the default executor
    // synthesized a placeholder `code-author-invoked-<plan.id>` that
    // did not match any real atom; now it must use the caller id.
    const realAtomId = 'code-author-invoked-plan-threaded-2026-04-21T00:00:00Z-ff00aa' as AtomId;
    await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: realAtomId });
    const body = (prFields[0]?.['fields'] as Record<string, unknown>)['body'] as string;
    expect(body).toContain(`observation_atom_id: ${JSON.stringify(realAtomId)}`);
    expect(body).not.toContain('code-author-invoked-plan-threaded"'); // the old placeholder shape
  });

  it('commit message carries plan title + draft notes', async () => {
    const plan = mkPlan('plan-commit', '# plan\n\ncontent', {
      target_paths: ['README.md'],
      title: 'Release prep',
    });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'The specific change: bumped version.',
      confidence: 0.9,
    });

    const { impl: execImpl, calls: gitCalls } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDefaultCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 7, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
    });

    await executor.execute({ plan, fence: mkFence(), correlationId: 'corr-1' });

    const commitCall = gitCalls.find((c) => c.args.includes('commit'));
    expect(commitCall).toBeDefined();
    const msgFlagIdx = commitCall!.args.indexOf('-m');
    expect(msgFlagIdx).toBeGreaterThanOrEqual(0);
    const msg = commitCall!.args[msgFlagIdx + 1];
    expect(msg).toContain('code-author: Release prep');
    expect(msg).toContain('The specific change: bumped version.');
  });
});
