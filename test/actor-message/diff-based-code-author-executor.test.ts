/**
 * Unit tests for buildDiffBasedCodeAuthorExecutor.
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
import type { Atom, AtomId, PrincipalId, Time } from '../../src/types.js';
import type { GhClient } from '../../src/external/github/index.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  buildDiffBasedCodeAuthorExecutor,
  buildSelfCorrectingPrompt,
  verifyCitedPaths,
} from '../../src/runtime/actor-message/diff-based-code-author-executor.js';
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
  const calls: Array<{ args: ReadonlyArray<string>; input?: string; cwd?: string }> = [];
  let i = 0;
  const impl = (async (_bin: string, args: ReadonlyArray<string>, options: Record<string, unknown>) => {
    calls.push({
      args: args.slice(),
      ...(options['input'] !== undefined ? { input: options['input'] as string } : {}),
      ...(options['cwd'] !== undefined ? { cwd: options['cwd'] as string } : {}),
    });
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

describe('buildDiffBasedCodeAuthorExecutor', () => {
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

    const executor = buildDiffBasedCodeAuthorExecutor({
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
    const executor = buildDiffBasedCodeAuthorExecutor({
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
    const executor = buildDiffBasedCodeAuthorExecutor({
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
    const executor = buildDiffBasedCodeAuthorExecutor({
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
    const executor = buildDiffBasedCodeAuthorExecutor({
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

  it('sanitizer collapses long disallowed-char runs without polynomial backtracking', async () => {
    // Adversarial plan id mixes 60 chars of `?` (each disallowed) with
    // 60 chars of `-` (kept literal in the old impl, still collapses
    // in the new one). The CodeQL polynomial-redos heuristic flagged
    // the previous regex-based sanitizer; this regression test pins
    // output shape so a future revert cannot silently re-introduce
    // the unsafe form. Linearity is guaranteed by the impl (single
    // pass, length-bounded); we assert correctness here.
    const adversarial = 'a' + '?'.repeat(60) + '-'.repeat(60) + 'b';
    const plan = mkPlan(adversarial, '# plan\n\ncontent', {
      target_paths: ['README.md'],
    });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'ok',
      confidence: 0.9,
    }, '');
    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDiffBasedCodeAuthorExecutor({
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
    // The runs of `?` and `-` collapse to a single `-` between the
    // bookend letters; the surrounding `code-author/` and `-nonce1`
    // segments come from the executor wrapping.
    expect(result.branchName).toBe('code-author/a-b-nonce1');
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
    const executor = buildDiffBasedCodeAuthorExecutor({
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
    // timestamp + nonce components. Previously the diff-based executor
    // synthesized a placeholder `code-author-invoked-<plan.id>` that
    // did not match any real atom; now it must use the caller id.
    const realAtomId = 'code-author-invoked-plan-threaded-2026-04-21T00:00:00Z-ff00aa' as AtomId;
    await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: realAtomId });
    const body = (prFields[0]?.['fields'] as Record<string, unknown>)['body'] as string;
    expect(body).toContain(`observation_atom_id: ${JSON.stringify(realAtomId)}`);
    expect(body).not.toContain('code-author-invoked-plan-threaded"'); // the old placeholder shape
  });

  it('fileContents: pre-reads target_paths via readFileFn and passes to drafter', async () => {
    // Closes the APPEND/MODIFY gap: the drafter has no repo access
    // and needs byte-exact file content to compute valid hunk
    // headers. The diff-based executor owns the fs seam (it already
    // knows repoDir) and pre-loads each target before the LLM call.
    // Tests inject a readFileFn so no real disk I/O happens.
    const plan = mkPlan('plan-filecontent', '# Append line', {
      target_paths: ['README.md'],
      title: 'Append line',
    });
    const readmeBody = '# LAG\n\nLine 2\n';
    const readCalls: string[] = [];
    const readFileFn = async (abs: string): Promise<string> => {
      readCalls.push(abs);
      if (abs.endsWith('README.md')) return readmeBody;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    // Drafter response is keyed on the full DATA block; registering
    // WITH `file_contents` is the assertion that the executor
    // forwarded it. If the executor skipped the fs step the hash
    // would not match and the test would fail with "no registered
    // response" -- exactly the gap we are closing.
    const data = {
      plan_id: String(plan.id),
      plan_title: 'Append line',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      file_contents: [{ path: 'README.md', content: readmeBody }],
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, {
      diff: VALID_DIFF,
      notes: 'Appended using supplied content.',
      confidence: 0.9,
    });

    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 9, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      readFileFn,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('dispatched');
    // path.resolve normalizes to the platform absolute form;
    // on POSIX this is /repo/README.md, on Windows it is
    // C:\repo\README.md (resolve prefixes a drive letter).
    // Assert on the tail (platform-agnostic) so the test runs on
    // both.
    expect(readCalls).toHaveLength(1);
    const normalized = readCalls[0]!.replace(/\\/g, '/');
    expect(normalized.endsWith('/repo/README.md')).toBe(true);
  });

  it('fileContents: missing files (ENOENT) are skipped, not thrown (CREATE path)', async () => {
    // When a plan targets a file that does not yet exist in the
    // working tree -- the CREATE case -- readFileFn throws ENOENT.
    // The executor must catch it, skip the entry, and let the
    // drafter handle the absence as `--- /dev/null` on the diff.
    // If we propagated ENOENT the executor would return an error
    // result for every CREATE, breaking the exact path PR #113
    // exercised.
    const plan = mkPlan('plan-create', '# Create file', {
      target_paths: ['docs/new.md'],
      title: 'Create file',
    });
    const readFileFn = async (_abs: string): Promise<string> => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    // Drafter sees no file_contents (key omitted -> path was skipped).
    registerDrafterResponse(host, plan, ['docs/new.md'], {
      diff: [
        '--- /dev/null',
        '+++ b/docs/new.md',
        '@@ -0,0 +1,1 @@',
        '+hello',
        '',
      ].join('\n'),
      notes: 'Created new file.',
      confidence: 0.95,
    });

    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 10, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      readFileFn,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('dispatched');
  });

  it('target_paths: falls back to heuristic regex over plan content when metadata has none', async () => {
    // The deliberation path can produce a Decision (and therefore a
    // plan atom) whose metadata lacks `target_paths`. Today a freeform
    // Decision prose -- "Append to docs/foo.md" -- would skip scope
    // enforcement entirely. The heuristic extracts paths that match
    // the `<dir>/<file>.<ext>` shape with a known text/code extension;
    // it is a fallback, not the structured path, so the validation
    // rules stay the same as if `target_paths` had been set.
    const plan = mkPlan(
      'plan-heuristic',
      'Modify docs/dogfooding/README.md and no other file to append a line.',
      {},
    );
    // drafter sees target_paths = ['docs/dogfooding/README.md'] by
    // virtue of the heuristic; registering against that shape.
    const data = {
      plan_id: 'plan-heuristic',
      plan_title: 'Bump README',
      plan_content: plan.content,
      target_paths: ['docs/dogfooding/README.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, {
      diff: [
        '--- a/docs/dogfooding/README.md',
        '+++ b/docs/dogfooding/README.md',
        '@@ -1,1 +1,2 @@',
        ' existing',
        '+appended',
        '',
      ].join('\n'),
      notes: 'Appended.',
      confidence: 0.9,
    });

    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    // File does not exist at repoDir -> ENOENT -> no file_contents
    // entry -> drafter data does not include file_contents -> key
    // stays absent in DATA (matches the registered fixture above).
    const readFileFn = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 11, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      readFileFn,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.touchedPaths).toEqual(['docs/dogfooding/README.md']);
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
    const executor = buildDiffBasedCodeAuthorExecutor({
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

  it('security: target_paths heuristic rejects `..` segments (sandbox escape)', async () => {
    // CR flagged path traversal on PR #117: a plan whose prose
    // contains `"append to ../../etc/passwd.md"` would let the
    // heuristic extractor emit that path, and `join(repoDir, p)`
    // would resolve it OUTSIDE repoDir -- the drafter would then
    // see the contents of an arbitrary file on disk, and worse
    // the executor would try to apply a diff against it. The
    // heuristic must reject any match containing a `..` segment,
    // and the reader must re-verify the resolved absolute path
    // stays inside repoDir.
    const plan = mkPlan(
      'plan-escape',
      'Append a line to ../../etc/passwd.md and also docs/ok.md as noted.',
      {}, // no target_paths in metadata -> heuristic runs
    );
    // readFileFn tracks calls so we can assert NO read happened
    // against the escape path. Record all paths touched.
    const reads: string[] = [];
    const readFileFn = async (abs: string): Promise<string> => {
      reads.push(abs);
      // Return an innocuous content for docs/ok.md; ENOENT for anything else.
      // resolve() prefixes a drive letter on Windows (`C:\repo\docs\ok.md`)
      // while POSIX gives `/repo/docs/ok.md`; normalize before matching.
      const normalized = abs.replace(/\\/g, '/');
      if (normalized.endsWith('/repo/docs/ok.md')) return 'ok-body\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    // The drafter registers a response keyed on the sanitized set
    // of target_paths. Since `..` path is rejected by the
    // extractor, only `docs/ok.md` reaches the drafter.
    const data = {
      plan_id: 'plan-escape',
      plan_title: 'Bump README',
      plan_content: plan.content,
      target_paths: ['docs/ok.md'],
      success_criteria: '',
      file_contents: [{ path: 'docs/ok.md', content: 'ok-body\n' }],
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, {
      diff: [
        '--- a/docs/ok.md',
        '+++ b/docs/ok.md',
        '@@ -1,1 +1,2 @@',
        ' ok-body',
        '+appended',
        '',
      ].join('\n'),
      notes: 'ok',
      confidence: 0.9,
    });

    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 42, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      readFileFn,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    if (result.kind !== 'dispatched') {
      throw new Error(`expected dispatched, got ${result.kind}; stage=${(result as { stage?: string }).stage ?? '-'} reason=${(result as { reason?: string }).reason ?? '-'}; reads=${JSON.stringify(reads)}`);
    }
    expect(result.kind).toBe('dispatched');
    // No read attempt must resolve outside repoDir. The extractor
    // rejects `../../etc/passwd.md`, so reads only hit the safe
    // docs/ok.md path (possibly with a drive-letter prefix on
    // Windows after path.resolve).
    for (const r of reads) {
      const normalized = r.replace(/\\/g, '/');
      expect(normalized).toContain('/repo/');
      expect(normalized).not.toContain('/etc/passwd');
      // `path.resolve` collapses `..`, so a resolved path never
      // contains a literal `..` segment. Assert on the concrete
      // leaf: the only touched file is docs/ok.md.
      expect(normalized.endsWith('/repo/docs/ok.md')).toBe(true);
    }
  });

  it('heuristic: extracts top-level filenames from prose when no target_paths metadata exists', async () => {
    // Regression: the prior regex required at least one `/` segment
    // and silently dropped top-level paths like `README.md` or
    // `package.json`. Plans whose prose mentions only top-level files
    // should now yield those as the resolved target set so the drafter
    // reads + diffs them correctly.
    const plan = mkPlan(
      'plan-toplevel',
      'Update README.md to mention the new feature.',
      {}, // no target_paths -> heuristic runs
    );
    const reads: string[] = [];
    const readFileFn = async (abs: string): Promise<string> => {
      reads.push(abs);
      const normalized = abs.replace(/\\/g, '/');
      if (normalized.endsWith('/repo/README.md')) return 'old-body\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const data = {
      plan_id: 'plan-toplevel',
      plan_title: 'Bump README',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      file_contents: [{ path: 'README.md', content: 'old-body\n' }],
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, {
      diff: [
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1,1 +1,2 @@',
        ' old-body',
        '+new-line',
        '',
      ].join('\n'),
      notes: 'ok',
      confidence: 0.9,
    });
    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'nonce1',
      execImpl,
      readFileFn,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    if (result.kind !== 'dispatched') {
      throw new Error(`expected dispatched, got ${result.kind}; stage=${(result as { stage?: string }).stage ?? '-'} reason=${(result as { reason?: string }).reason ?? '-'}`);
    }
    // The drafter call only matches when target_paths === ['README.md'];
    // the registered response covers exactly that key, so a successful
    // dispatched result confirms the heuristic extracted the top-level
    // filename. Read tracking provides defense-in-depth: only README.md
    // should be touched.
    for (const r of reads) {
      const normalized = r.replace(/\\/g, '/');
      expect(normalized.endsWith('/repo/README.md')).toBe(true);
    }
    expect(reads.length).toBeGreaterThan(0);
  });

  it('heuristic: strips unified-diff `a/` and `b/` prefixes when Decision echoes a diff block', async () => {
    // Surfaced by live E2E #3b: the virtual org's Decision was
    // itself a valid unified diff. The heuristic matched both
    // `a/docs/foo.md` and `b/docs/foo.md` and emitted them as
    // distinct targets; the LLM then produced a diff touching the
    // bare `docs/foo.md`, and the drafter path-scope check rejected
    // it because `docs/foo.md` was NOT in the inflated target set.
    // After normalization, both prefixed fragments fold to the same
    // bare path and the scope check aligns with the drafter output.
    const plan = mkPlan(
      'plan-embedded-diff',
      '--- /dev/null\n+++ b/docs/sample.md\n@@ -0,0 +1,1 @@\n+hello\n',
      {},
    );
    const data = {
      plan_id: 'plan-embedded-diff',
      plan_title: 'Bump README',
      plan_content: plan.content,
      target_paths: ['docs/sample.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, {
      diff: [
        '--- /dev/null',
        '+++ b/docs/sample.md',
        '@@ -0,0 +1,1 @@',
        '+hello',
        '',
      ].join('\n'),
      notes: 'create file',
      confidence: 0.95,
    });
    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const readFileFn = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 99, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      readFileFn,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    expect(result.touchedPaths).toEqual(['docs/sample.md']);
  });

  it('heuristic: preserves top-level `a/` or `b/` directories that are NOT diff prefixes', async () => {
    // Guard against over-eager stripping. A legitimate repo layout
    // like `a/index.md` (top-level dir literally named `a`) must
    // survive the heuristic intact; stripping would collapse it to
    // the leaf `index.md` and the drafter would then reject the
    // drafter-produced diff targeting `a/index.md` because
    // `index.md` is not in the inflated scope. The fold only runs
    // when the stripped path still has at least one `/`.
    const plan = mkPlan(
      'plan-toplevel-a',
      'touch file a/index.md to bump version',
      {},
    );
    const data = {
      plan_id: 'plan-toplevel-a',
      plan_title: 'Bump README',
      plan_content: plan.content,
      target_paths: ['a/index.md'],
      success_criteria: '',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, {
      diff: [
        '--- a/a/index.md',
        '+++ b/a/index.md',
        '@@ -1,1 +1,1 @@',
        '-hello',
        '+world',
        '',
      ].join('\n'),
      notes: 'update top-level a/',
      confidence: 0.9,
    });
    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const readFileFn = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 100, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      readFileFn,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    // Top-level `a/` must be PRESERVED, not stripped to `index.md`.
    expect(result.touchedPaths).toEqual(['a/index.md']);
  });

  it('security: target_paths from metadata with `..` is rejected by reader sandbox', async () => {
    // Defense in depth: even if target_paths comes from structured
    // metadata (bypasses the heuristic's `..` check), the executor's
    // reader must re-verify the resolved absolute path stays inside
    // repoDir. A plan that managed to get `../escape.md` into its
    // metadata must not exfiltrate that file or be able to write
    // to it via the downstream diff.
    const plan = mkPlan('plan-meta-escape', 'metadata escape', {
      target_paths: ['../escape.md'],
      title: 'Meta escape attempt',
    });
    const reads: string[] = [];
    const readFileFn = async (abs: string): Promise<string> => {
      reads.push(abs);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    // Register a response where target_paths is declared as supplied
    // but file_contents is empty (reader rejected the escape path).
    registerDrafterResponse(host, plan, ['../escape.md'], {
      diff: '',
      notes: 'could not resolve safely',
      confidence: 0.2,
    });

    const { impl: execImpl } = stubGitExeca([
      { exitCode: 0 },                                        // status
      { exitCode: 0 },                                        // fetch
      { exitCode: 0 },                                        // checkout
    ]);
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 43, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      readFileFn,
    });
    await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    // No fs read should have been attempted against the escape path.
    expect(reads).toHaveLength(0);
  });

  it('question_prompt metadata is forwarded from plan to drafter DATA block', async () => {
    // Closes the deliberation-paraphrase gap: when the Decision
    // answer has reduced the Question's concrete payload to an
    // abstract reference, the drafter reads the verbatim payload
    // from `plan.metadata.question_prompt` (embedded by
    // `executeDecision`) and emits a diff against the literal
    // content, not the paraphrase.
    const plan = mkPlan(
      'plan-qprompt',
      'APPROVE appending the specified line to README.md',
      {
        target_paths: ['README.md'],
        title: 'Append line',
        question_prompt: 'Append exactly this line to the end of README.md: - entry',
      },
    );
    // Registering with `question_prompt` in the DATA block: this is
    // how we assert the executor forwarded the field. Miss -> MemoryLLM
    // throws "no registered response", which is exactly the gap this
    // seam closes.
    const data = {
      plan_id: 'plan-qprompt',
      plan_title: 'Append line',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      question_prompt: 'Append exactly this line to the end of README.md: - entry',
      fence_snapshot: {
        max_usd_per_pr: 10,
        required_checks: ['Node 22 on ubuntu-latest'],
      },
    };
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, data, {
      diff: VALID_DIFF,
      notes: 'Used verbatim Question prompt.',
      confidence: 0.92,
    });

    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const readFileFn = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 200, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/repo',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      readFileFn,
    });
    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('dispatched');
  });

  it('drafter retry: diff-apply-failed on first attempt, succeeds on second (self-correction)', async () => {
    // The LLM produces unified diffs; line-count arithmetic in
    // `@@ -X,Y +A,B @@` headers must match the file byte-for-byte.
    // Empirically ~10-30% of attempts produce a malformed diff
    // (drift, stray BOM, etc.). The executor must self-correct
    // by re-prompting the drafter with the prior diff + git's
    // rejection reason, NOT bail at the first failure.
    const plan = mkPlan('plan-retry-success', '# plan\n\ncontent', {
      target_paths: ['README.md'],
      title: 'Retry happy path',
    });
    // Register two distinct drafter responses: the first is a
    // malformed diff (will reject), the second a valid one (will
    // succeed). Different DATA fingerprints because the second call
    // includes the retry/self-correction questionPrompt.
    const baseData = {
      plan_id: String(plan.id),
      plan_title: 'Retry happy path',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: { max_usd_per_pr: 10, required_checks: ['Node 22 on ubuntu-latest'] },
    };
    const malformedDiff = '--- a/README.md\n+++ b/README.md\nGARBAGE\n';
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, baseData, {
      diff: malformedDiff,
      notes: 'first try',
      confidence: 0.7,
    });

    // git replies: first apply-check fails (exit 1), then second
    // attempt's full happy-path replies. The git-ops sequence per
    // attempt is: status, fetch, checkout-base, checkout-b,
    // apply-check (fails on attempt 1), reset (post-fail cleanup,
    // not always needed), apply, add, commit, push.
    // Look at git-ops.ts for the exact sequence; the retry loop
    // re-enters at the top so each attempt repeats fetch+checkout.
    // Build replies for: attempt 1 (status + fetch + checkout-base +
    // checkout-b + apply-check FAIL) then attempt 2 (full happy).
    const replies = [
      // attempt 1
      { exitCode: 0 }, // status
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout base
      { exitCode: 0 }, // checkout -b
      { exitCode: 1, stderr: 'error: corrupt patch at line 3' }, // apply --check fails
      // attempt 2
      ...GIT_HAPPY_REPLIES,
    ];
    const { impl: execImpl } = stubGitExeca(replies);

    // Compute the EXACT self-correction prompt the executor will
    // emit on retry by calling its own helper. Plan metadata
    // carries no original question_prompt (base=undefined); the
    // git-ops stub returns exit 1 at the `git apply` step (not the
    // pre-check), so the error string mirrors the apply stage.
    const exactRetryPrompt = buildSelfCorrectingPrompt({
      base: undefined,
      previousDiff: malformedDiff,
      previousError: 'git apply failed after successful --check: error: corrupt patch at line 3 (stage=apply)',
    });
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, { ...baseData, question_prompt: exactRetryPrompt }, {
      diff: VALID_DIFF,
      notes: 'second try (corrected)',
      confidence: 0.92,
    });

    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 42, html_url: 'h', url: 'u', node_id: 'n', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('dispatched');
    if (result.kind !== 'dispatched') throw new Error('unreachable');
    // Confidence comes from the SECOND drafter response -- the
    // self-corrected one. Verifies the executor used the retry
    // result, not the first-attempt result that got rejected.
    expect(result.confidence).toBeCloseTo(0.92);
  });

  it('drafter retry: gives up after maxDraftAttempts and surfaces typed error', async () => {
    // If the LLM keeps producing malformed diffs, the executor
    // must give up cleanly with a typed apply-branch error rather
    // than spinning indefinitely.
    const plan = mkPlan('plan-retry-exhaust', '# plan', {
      target_paths: ['README.md'],
      title: 'Retry exhaustion',
    });
    const baseData = {
      plan_id: String(plan.id),
      plan_title: 'Retry exhaustion',
      plan_content: plan.content,
      target_paths: ['README.md'],
      success_criteria: '',
      fence_snapshot: { max_usd_per_pr: 10, required_checks: ['Node 22 on ubuntu-latest'] },
    };
    const malformedDiff = '--- a/README.md\n+++ b/README.md\nBROKEN\n';
    // Single attempt, drafter returns malformed.
    host.llm.register(DRAFT_SCHEMA, DRAFT_SYSTEM_PROMPT, baseData, {
      diff: malformedDiff,
      notes: 'attempt 1',
      confidence: 0.5,
    });

    // git: status, fetch, checkout, checkout-b, apply-check fails.
    const replies = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 1, stderr: 'error: corrupt patch at line 3' },
    ];
    const { impl: execImpl } = stubGitExeca(replies);

    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      maxDraftAttempts: 1, // force giving up after 1 attempt
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('apply-branch/diff-apply-failed');
    expect(result.reason).toContain('attempt 1/1');
  });

  it('drafter retry: dirty-worktree on first attempt does NOT retry (env error, not LLM)', async () => {
    // Only diff-quality errors (diff-apply-failed) trigger retry.
    // dirty-worktree, fetch-failed, push-failed, etc. won't change
    // between LLM calls and re-running wastes tokens.
    const plan = mkPlan('plan-no-retry-dirty', '# plan', {
      target_paths: ['README.md'],
      title: 'No retry on dirty',
    });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF, // would succeed if applied
      notes: 'ok',
      confidence: 0.9,
    });

    // git status returns dirty -> dirty-worktree throws on first
    // attempt; should NOT retry.
    const { impl: execImpl, calls } = stubGitExeca([
      { exitCode: 0, stdout: ' M src/foo.ts\n' },
    ]);
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      nonce: () => 'abc',
      execImpl,
      maxDraftAttempts: 3, // generous budget; should still fail-fast
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-1' as AtomId });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('apply-branch/dirty-worktree');
    // Only 1 git call before the throw -- proves no retry.
    expect(calls.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Regression: workspace-provider isolation (dirty-primary, clean-isolated)
  // ---------------------------------------------------------------------------
  // The autonomous-dispatch wiring runs against the operator's primary
  // checkout, which can carry untracked files (canonical screenshots,
  // exploratory plan markdown, .gitignore drafts) for an entire elevation
  // window. Without an isolation seam, every dispatch failed at
  // apply-branch/dirty-worktree because git-ops.ts ran `git status
  // --porcelain` against the primary's cwd. The fix is a per-execute
  // workspace acquired off the configured baseRef; the executor
  // pre-reads target files, verifies cited paths, AND runs every git
  // invocation against that workspace's path. The configured `repoDir`
  // becomes irrelevant for the duration of the dispatch -- a primary
  // dirty enough to fail naive `git status` MUST NOT block a workspace-
  // backed dispatch.
  //
  // These tests pin:
  //   1. effective-cwd swap: every git call sees workspace.path, not config.repoDir
  //   2. release-on-success: workspace is released after a dispatched result
  //   3. release-on-error: workspace is released even when the inner pipeline throws
  //   4. acquire-failure: typed stage `workspace-acquire/failed` surfaces the cause
  //   5. principal gate: provider set without principal returns workspace-acquire/missing-principal

  function fakeWorkspaceProvider(
    workspacePath: string,
    opts: { acquireThrows?: Error; releaseThrows?: Error } = {},
  ) {
    const events: string[] = [];
    const provider = {
      async acquire(input: { principal: string; baseRef: string; correlationId: string }) {
        events.push(`acquire(principal=${input.principal},baseRef=${input.baseRef},correlationId=${input.correlationId})`);
        if (opts.acquireThrows) throw opts.acquireThrows;
        return { id: 'fake-ws-id', path: workspacePath, baseRef: input.baseRef };
      },
      async release(workspace: { id: string; path: string; baseRef: string }) {
        events.push(`release(id=${workspace.id})`);
        if (opts.releaseThrows) throw opts.releaseThrows;
      },
    };
    return { provider, events };
  }

  it('regression: workspaceProvider isolates primary cwd from dispatch (dirty primary -> dispatched)', async () => {
    // Simulate the production failure mode: the operator's primary
    // worktree is dirty (configured `repoDir` is the dirty path), but
    // the workspace provider mints a clean isolated path. Every git
    // invocation runs against the workspace path, so `git status
    // --porcelain` returns clean and dispatch proceeds.
    const plan = mkPlan('plan-iso', '# plan\n\ncontent', { target_paths: ['README.md'] });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'ok',
      confidence: 0.9,
    });

    const { impl: execImpl, calls: gitCalls } = stubGitExeca(GIT_HAPPY_REPLIES);
    const { provider, events } = fakeWorkspaceProvider('/tmp/clean-isolated');

    const ghClient = ghClientStub((async () => ({
      number: 42, html_url: 'https://github.com/o/r/pull/42', url: '', node_id: '', state: 'open',
    })) as GhClient['rest']);

    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient,
      owner: 'o',
      repo: 'r',
      // The configured `repoDir` is the operator's dirty primary --
      // identical to the production failure mode. The fix means every
      // git call ignores this path in favour of `workspace.path`.
      repoDir: '/tmp/dirty-primary',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
      workspaceProvider: provider,
      principal: 'cto-actor' as PrincipalId,
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'corr-iso-1', observationAtomId: 'obs-iso-1' as AtomId });
    expect(result.kind).toBe('dispatched');

    // Every git invocation MUST have run against workspace.path. If a
    // single call leaks back to `/tmp/dirty-primary`, the
    // dirty-worktree symptom returns the moment a real worktree is
    // dirty, and the substrate-purity invariant is broken.
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const c of gitCalls) {
      expect(c.cwd, `every git invocation must capture cwd; missing on ${c.args.join(' ')}`).toBeDefined();
      expect(c.cwd, `git ran against /tmp/dirty-primary instead of workspace.path on args=${c.args.join(' ')}`).not.toBe('/tmp/dirty-primary');
      expect(c.cwd, `git ran outside the isolated workspace on args=${c.args.join(' ')}`).toBe('/tmp/clean-isolated');
    }
    // Acquire-then-release order is guaranteed by the try/finally.
    expect(events).toEqual([
      'acquire(principal=cto-actor,baseRef=main,correlationId=corr-iso-1)',
      'release(id=fake-ws-id)',
    ]);
  });

  it('regression: workspaceProvider releases the workspace even when the pipeline errors', async () => {
    // Verify try/finally semantics: a thrown drafter error or a
    // git-ops failure MUST NOT leak the workspace. The provider fakes
    // record both events; the test asserts release fires regardless
    // of the dispatched/error result kind.
    const plan = mkPlan('plan-iso-err', '# plan\n\ncontent', { target_paths: ['README.md'] });
    // No drafter response registered -> drafter throws
    // DrafterError(llm-call-failed); pipeline returns error.
    const { impl: execImpl } = stubGitExeca(GIT_HAPPY_REPLIES);
    const { provider, events } = fakeWorkspaceProvider('/tmp/clean-isolated-err');

    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r',
      repoDir: '/tmp/dirty-primary',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
      workspaceProvider: provider,
      principal: 'cto-actor' as PrincipalId,
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'corr-iso-err', observationAtomId: 'obs-iso-err' as AtomId });
    expect(result.kind).toBe('error');
    expect(events).toEqual([
      'acquire(principal=cto-actor,baseRef=main,correlationId=corr-iso-err)',
      'release(id=fake-ws-id)',
    ]);
  });

  it('regression: workspaceProvider.acquire throws -> workspace-acquire/failed', async () => {
    // A provider whose underlying git/fs operation fails (e.g.
    // baseRef not found, .worktrees disk full) MUST surface a typed
    // stage so the dashboard + observation atom record where it
    // stopped. The pipeline never starts; no drafter response is
    // needed, no git stub is called.
    const plan = mkPlan('plan-iso-acq', '# plan\n\ncontent', { target_paths: ['README.md'] });
    const { impl: execImpl, calls } = stubGitExeca([]);
    const { provider } = fakeWorkspaceProvider('/tmp/never-reached', {
      acquireThrows: new Error('GitWorktreeProvider: baseRef \'main\' not found in repo'),
    });

    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r',
      repoDir: '/tmp/dirty-primary',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
      workspaceProvider: provider,
      principal: 'cto-actor' as PrincipalId,
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-x' as AtomId });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('workspace-acquire/failed');
    expect(result.reason).toMatch(/baseRef 'main' not found/);
    // Pipeline never started -> no git invocations, no drafter call.
    expect(calls.length).toBe(0);
  });

  it('regression: workspaceProvider set without principal -> workspace-acquire/missing-principal', async () => {
    // The provider seam is principal-aware (cred-copying decisions
    // belong to the provider). A misconfigured deployment that wires
    // the provider without a principal id MUST fail loud at execute
    // time rather than acquire under an unspecified identity.
    const plan = mkPlan('plan-iso-noprin', '# plan\n\ncontent', { target_paths: ['README.md'] });
    const { impl: execImpl } = stubGitExeca([]);
    const { provider, events } = fakeWorkspaceProvider('/tmp/never-reached');

    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r',
      repoDir: '/tmp/dirty-primary',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
      workspaceProvider: provider,
      // principal deliberately omitted
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-x' as AtomId });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('workspace-acquire/missing-principal');
    // Provider was never called -- the gate fires before acquire().
    expect(events).toEqual([]);
  });

  it('regression: back-compat -- without workspaceProvider, repoDir is used directly (dirty primary still fails)', async () => {
    // Pin that the back-compat path is unchanged: a dispatch with no
    // provider configured still hits the dirty-worktree gate when the
    // configured repoDir is dirty. The fix introduces an opt-in seam,
    // not a behaviour change for existing callers.
    const plan = mkPlan('plan-bc', '# plan\n\ncontent', { target_paths: ['README.md'] });
    registerDrafterResponse(host, plan, ['README.md'], {
      diff: VALID_DIFF,
      notes: 'ok',
      confidence: 0.9,
    });
    const { impl: execImpl } = stubGitExeca([
      { exitCode: 0, stdout: ' M src/foo.ts\n' }, // dirty
    ]);
    const executor = buildDiffBasedCodeAuthorExecutor({
      host,
      ghClient: ghClientStub((async () => ({
        number: 1, html_url: '', url: '', node_id: '', state: 'open',
      })) as GhClient['rest']),
      owner: 'o', repo: 'r', repoDir: '/tmp/x',
      gitIdentity: { name: 'n', email: 'e@x' },
      model: 'claude-opus-4-7',
      execImpl,
      // No workspaceProvider -> back-compat path
    });

    const result = await executor.execute({ plan, fence: mkFence(), correlationId: 'c', observationAtomId: 'obs-bc' as AtomId });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('unreachable');
    expect(result.stage).toBe('apply-branch/dirty-worktree');
  });
});

describe('buildSelfCorrectingPrompt', () => {
  it('returns base unchanged on first attempt (no previous diff/error)', async () => {
    expect(
      buildSelfCorrectingPrompt({ base: 'do the thing', previousDiff: null, previousError: null }),
    ).toBe('do the thing');
    expect(
      buildSelfCorrectingPrompt({ base: undefined, previousDiff: null, previousError: null }),
    ).toBe(undefined);
  });

  it('appends a SELF-CORRECTION block on retry', async () => {
    const out = buildSelfCorrectingPrompt({
      base: 'fix the README',
      previousDiff: '--- a/README.md\n+++ b/README.md\nBROKEN',
      previousError: 'error: corrupt patch at line 3 (stage=apply-check)',
    });
    expect(out).toContain('ORIGINAL_REQUEST:');
    expect(out).toContain('fix the README');
    expect(out).toContain('PREVIOUS_ATTEMPT_REJECTED_BY_GIT_APPLY:');
    expect(out).toContain('error: corrupt patch at line 3');
    expect(out).toContain('PREVIOUS_DIFF');
    expect(out).toContain('BROKEN');
    expect(out).toContain('Produce a CORRECTED unified diff');
    expect(out).toContain('@@ -X,Y +A,B @@');
  });

  it('omits ORIGINAL_REQUEST section when base prompt is undefined', async () => {
    const out = buildSelfCorrectingPrompt({
      base: undefined,
      previousDiff: 'd',
      previousError: 'e',
    });
    expect(out).not.toContain('ORIGINAL_REQUEST:');
    expect(out).toContain('PREVIOUS_ATTEMPT_REJECTED_BY_GIT_APPLY:');
  });
});

describe('verifyCitedPaths', () => {
  // Use the system temp dir via Node fs primitives so the test does
  // not depend on a real repo checkout. Each test creates a small
  // file/directory tree, then calls verifyCitedPaths with citations
  // that should resolve (or escape, or miss).
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(joinPath(tmpdir(), 'lag-cited-paths-'));
    await writeFile(joinPath(tmp, 'README.md'), '# present', 'utf8');
    await mkdir(joinPath(tmp, 'docs'), { recursive: true });
    await writeFile(joinPath(tmp, 'docs', 'arch.md'), 'present', 'utf8');
    await mkdir(joinPath(tmp, 'src', 'runtime'), { recursive: true });
  });

  // Cleanup runs as a final step inside each test (since vitest's
  // afterEach is not wired in this file's existing test fixtures).
  // The test framework deletes tmpdirs eventually anyway; explicit
  // rm keeps the disk tidy when the suite is run repeatedly.
  async function cleanup(): Promise<void> {
    await rm(tmp, { recursive: true, force: true });
  }

  it('returns ok when every cited path exists on the working tree', async () => {
    const r = await verifyCitedPaths(
      ['README.md', 'docs/arch.md', 'src/runtime/'],
      tmp,
    );
    expect(r).toEqual({ kind: 'ok' });
    await cleanup();
  });

  it('returns ok with an empty cited_paths list (back-compat)', async () => {
    const r = await verifyCitedPaths([], tmp);
    expect(r).toEqual({ kind: 'ok' });
    await cleanup();
  });

  it('rejects an entry that does not exist with a missing-path error', async () => {
    const r = await verifyCitedPaths(['docs/missing.md'], tmp);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('does not exist');
      expect(r.message).toContain('"docs/missing.md"');
    }
    await cleanup();
  });

  it('rejects a path-traversal attempt that escapes the repository root', async () => {
    const r = await verifyCitedPaths(['../etc/passwd'], tmp);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('escapes the repository root');
    }
    await cleanup();
  });

  it('rejects an absolute path outright (entries must be repo-relative)', async () => {
    const r = await verifyCitedPaths([joinPath(tmp, 'README.md')], tmp);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('repository-relative');
    }
    await cleanup();
  });

  it('rejects an empty-string entry as a non-string violation', async () => {
    const r = await verifyCitedPaths([''], tmp);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('non-empty string');
    }
    await cleanup();
  });

  it('returns the FIRST failing entry when multiple paths are bad', async () => {
    // Order-deterministic: the function short-circuits on the first
    // failure. README.md exists, missing-1 does not. The error
    // message must mention missing-1 and not missing-2.
    const r = await verifyCitedPaths(
      ['README.md', 'docs/missing-1.md', 'docs/missing-2.md'],
      tmp,
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('docs/missing-1.md');
      expect(r.message).not.toContain('docs/missing-2.md');
    }
    await cleanup();
  });
});
