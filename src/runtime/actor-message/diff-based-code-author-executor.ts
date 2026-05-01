/**
 * Diff-based CodeAuthorExecutor: composes drafter + git-ops + pr-creation
 * into a single execute() call. The drafter emits a unified diff in one
 * LLM call; the executor applies it via git apply, commits, pushes, and
 * opens a PR.
 *
 * For multi-turn agentic execution (LLM iterates with real tools in an
 * isolated workspace), see `agentic-code-author-executor.ts`.
 *
 * This is one concrete implementation a consumer plugs in. A different
 * consumer (LangGraph-orchestrated, Temporal workflow, etc.) can
 * implement CodeAuthorExecutor against the same invoker without
 * importing these primitives.
 *
 * Stage map (each fails closed with a typed stage name on the error
 * return path so the observation atom records precisely where the
 * chain stopped):
 *   - drafter        LLM-backed diff generation
 *   - apply-branch   git fetch + apply + commit + push
 *   - pr-creation    GitHub pulls POST
 */

import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { execa } from 'execa';
import type { Atom, PrincipalId } from '../../types.js';
import type { Host } from '../../interface.js';
import type { GhClient } from '../../external/github/index.js';
import type { Workspace, WorkspaceProvider } from '../../substrate/workspace-provider.js';
import {
  draftCodeChange,
  DrafterError,
} from '../actors/code-author/drafter.js';
import {
  applyDraftBranch,
  GitOpsError,
  type GitIdentity,
} from '../actors/code-author/git-ops.js';
import {
  buildEmbeddedAtomSnapshots,
  createDraftPr,
  renderPrBody,
  PrCreationError,
} from '../actors/code-author/pr-creation.js';
import type {
  CodeAuthorExecutor,
  CodeAuthorExecutorResult,
} from './code-author-invoker.js';

export interface DiffBasedExecutorConfig {
  readonly host: Host;
  readonly ghClient: GhClient;
  readonly owner: string;
  readonly repo: string;
  /**
   * Repository path the executor operates against by default. When
   * `workspaceProvider` is set, this value is unused at execute time
   * (the workspace's path replaces it for the duration of one
   * dispatch); a malformed `repoDir` is therefore not a runtime error
   * for provider-backed deployments. Kept required so the back-compat
   * code path that operates on a caller-managed checkout has a single
   * authoritative source of truth for cwd.
   */
  readonly repoDir: string;
  readonly gitIdentity: GitIdentity;
  readonly model: string;
  readonly branchPrefix?: string;
  readonly baseBranch?: string;
  readonly remote?: string;
  /** Draft PR by default; operator can flip this per deployment. */
  readonly draft?: boolean;
  /** Passed through to drafter as LlmOptions.disallowedTools. */
  readonly disallowedTools?: ReadonlyArray<string>;
  /**
   * Optional nonce generator. Overridable for deterministic tests;
   * default is 6 hex chars of crypto randomness.
   */
  readonly nonce?: () => string;
  /**
   * Execa override; forwarded to applyDraftBranch.execImpl. When
   * absent the real execa ships out subprocesses. Tests inject a
   * stub so no git subprocess runs.
   */
  readonly execImpl?: typeof execa;
  /**
   * Optional isolated-workspace seam. When set, every `execute()`
   * call acquires a fresh workspace via `workspaceProvider.acquire`
   * BEFORE the drafter runs and releases it in a finally block,
   * regardless of pipeline outcome. The workspace's `path` becomes
   * the effective working directory for target-file pre-reads,
   * cited-paths verification, and every git invocation; the
   * `repoDir` configured at factory time is unused for the duration
   * of that dispatch.
   *
   * Why this seam exists
   * --------------------
   * The dirty-worktree gate inside `applyDraftBranch` exists so the
   * primitive can never silently fold an unrelated uncommitted file
   * into a draft commit. It is load-bearing: a clean cwd is part of
   * the primitive's contract. The autonomous-dispatch wiring needs
   * to honour that contract WITHOUT requiring the operator's primary
   * checkout to stay clean across an entire elevation window. An
   * isolated workspace per dispatch satisfies both invariants: the
   * primitive sees a clean tree by construction, and the operator's
   * checkout is decoupled from autonomous flow state.
   *
   * Substrate-purity properties
   * ---------------------------
   * - The executor never writes to `repoDir` when a provider is set;
   *   every git/fs invocation runs against `workspace.path`.
   * - `workspaceProvider.release(workspace)` runs in a finally so a
   *   crashed pipeline or a thrown drafter error cannot leak the
   *   workspace. A release error is swallowed so it cannot mask the
   *   upstream success/error result.
   * - The provider is principal-aware: cred-copying decisions belong
   *   to the provider impl, not the executor.
   */
  readonly workspaceProvider?: WorkspaceProvider;
  /**
   * Principal id forwarded to `workspaceProvider.acquire` when a
   * provider is set. Required only for provider-backed deployments;
   * legacy callers that manage their own checkout can leave it
   * unset. A provider that ignores principal (e.g. a tmpfs adapter
   * for tests) tolerates any value here.
   */
  readonly principal?: PrincipalId;
  /**
   * Inject a filesystem reader for the target-path pre-read step.
   * Given an absolute path, returns the file contents as UTF-8 text
   * or throws (the executor catches ENOENT-family errors and treats
   * the path as a CREATE; any other error is surfaced).
   *
   * Default: `fs.readFile(path, 'utf8')`. Tests inject a stub so the
   * executor's own fs access stays hermetic; production leaves it
   * undefined so real file content flows through.
   */
  readonly readFileFn?: (absolutePath: string) => Promise<string>;
  /**
   * How many drafter attempts the executor will make before giving
   * up. The retry loop self-corrects on diff-apply failures by
   * passing the prior diff + git's rejection reason back into the
   * drafter's questionPrompt; the LLM then produces a corrected
   * diff. Defaults to 3 attempts -- enough to absorb the empirical
   * 10-30% LLM diff-drift rate without spending tokens unboundedly.
   * Tests can shrink to 1 to assert no-retry behaviour or grow to
   * exercise multi-retry recovery.
   */
  readonly maxDraftAttempts?: number;
}

export function buildDiffBasedCodeAuthorExecutor(
  config: DiffBasedExecutorConfig,
): CodeAuthorExecutor {
  const branchPrefix = config.branchPrefix ?? 'code-author/';
  const baseBranch = config.baseBranch ?? 'main';
  const remote = config.remote ?? 'origin';
  const draft = config.draft ?? true;
  const nonce = config.nonce ?? (() => randomBytes(3).toString('hex'));
  // Fail-fast on a malformed maxDraftAttempts so a non-positive or
  // non-integer value cannot silently land in the unreachable-branch
  // generic error at the bottom of the loop. The retry budget is a
  // contract value; if a caller supplies 0, NaN, or a float, that
  // is a config bug, not a framework one.
  const maxDraftAttemptsRaw = config.maxDraftAttempts ?? 3;
  if (!Number.isInteger(maxDraftAttemptsRaw) || maxDraftAttemptsRaw < 1) {
    throw new Error(
      `DiffBasedExecutorConfig.maxDraftAttempts must be a positive integer; got ${String(config.maxDraftAttempts)}`,
    );
  }
  const maxDraftAttempts: number = maxDraftAttemptsRaw;

  return {
    async execute(inputs): Promise<CodeAuthorExecutorResult> {
      // Resolve the per-dispatch effective working directory. With a
      // workspace provider configured we acquire a fresh isolated
      // worktree off `baseBranch` for the duration of this single
      // execute() call; without one, fall back to the caller-managed
      // `config.repoDir`. The acquire+release pair is symmetric and
      // bounded: a thrown drafter or git-ops error still releases via
      // the finally below. `workspace` stays in scope so the finally
      // can read its handle without a sentinel mutation.
      let workspace: Workspace | null = null;
      if (config.workspaceProvider !== undefined) {
        if (config.principal === undefined) {
          return {
            kind: 'error',
            stage: 'workspace-acquire/missing-principal',
            reason: 'workspaceProvider is set but principal is not configured; provider-backed dispatch requires both',
          };
        }
        try {
          workspace = await config.workspaceProvider.acquire({
            principal: config.principal,
            baseRef: baseBranch,
            correlationId: inputs.correlationId,
          });
        } catch (err) {
          return {
            kind: 'error',
            stage: 'workspace-acquire/failed',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }
      const effectiveRepoDir = workspace !== null ? workspace.path : config.repoDir;
      try {
        return await runPipeline(inputs, effectiveRepoDir);
      } finally {
        if (workspace !== null && config.workspaceProvider !== undefined) {
          // Swallow release errors: a release failure must not mask
          // the upstream success/error the caller is about to
          // observe. Orphaned worktrees surface via the provider's
          // own auditing path (e.g. `git worktree prune`).
          await config.workspaceProvider.release(workspace).catch(() => undefined);
        }
      }
    },
  };

  /**
   * Inner pipeline: drafter -> apply-branch (git-ops) -> pr-creation,
   * parameterised on the effective working directory the caller resolved
   * (either `config.repoDir` or a workspace's `path`). Extracted so the
   * acquire+release scope around `execute` stays a thin wrapper.
   */
  async function runPipeline(
    inputs: Parameters<CodeAuthorExecutor['execute']>[0],
    repoDirArg: string,
  ): Promise<CodeAuthorExecutorResult> {
      const { plan, fence, correlationId, signal } = inputs;
      const planId = String(plan.id);
      // Sanitize plan id for use inside a git branch name. Git
      // ref-name rules reject `:`, `?`, `[`, `\`, `^`, `~`, control
      // chars, whitespace, trailing slashes, and `..` sequences.
      // An atom id is not required to conform; the caller may pass
      // anything that atoms accept. Replace forbidden bytes with `-`
      // and collapse repeats so a weird id does not fail at the
      // `git checkout -b` step downstream.
      const safeIdForRef = sanitizeGitRefComponent(planId);
      // Fresh branch name per attempt: each retry creates a new
      // branch (by re-rolling the nonce inside the loop) so a
      // previous attempt's `git checkout -b <name>` lingering in
      // local refs cannot cause "branch already exists" on retry.
      // Local branches that never push are harmless garbage; the
      // alternative (delete + recreate) adds a git op and a new
      // failure mode for marginal benefit.
      const meta = plan.metadata as Record<string, unknown>;
      // Resolution order for target paths:
      //   1. plan.metadata.target_paths (structured path, authoritative)
      //   2. heuristic parse of plan.content for <dir>/<file>.<ext>
      //      shapes with known text/code extensions (fallback for
      //      prose-only plans where no structured schema emitted
      //      target_paths). The heuristic is permissive: the caller
      //      can still pass a structured target_paths on the plan
      //      metadata and bypass regex entirely.
      const declared = extractStringArray(meta, 'target_paths');
      const targetPaths = declared.length > 0
        ? declared
        : extractTargetPathsFromProse(String(plan.content));
      const successCriteria = typeof meta['success_criteria'] === 'string'
        ? meta['success_criteria']
        : undefined;
      // The originating Question's prompt, if the plan-atom factory
      // embedded it under `question_prompt` in metadata. The plan
      // content is the Decision answer -- which is governance-layer
      // prose, sometimes abstract. The question prompt is the
      // concrete payload the operator/agent asked for. Forwarded to
      // the drafter so the LLM has the literal content to diff
      // against, not just the abstract plan reference.
      const questionPrompt = typeof meta['question_prompt'] === 'string'
        ? meta['question_prompt']
        : undefined;

      // Pre-read each target file so the drafter sees byte-exact
      // content + line counts. A missing file (ENOENT) is treated
      // as a CREATE: we skip the entry, the drafter does not get
      // a file_contents row for that path, and the LLM is expected
      // to emit `--- /dev/null` on the old side per the system
      // prompt's rule 6. Any other fs error propagates.
      const readFn = config.readFileFn ?? ((p: string) => readFile(p, 'utf8'));
      const fileContents = await readTargetContents(targetPaths, repoDirArg, readFn);

      // Drafter + apply-branch retry loop. The drafter (LLM) emits
      // unified diffs, which is intrinsically lossy: line-count
      // arithmetic in `@@ -X,Y +A,B @@` headers must match the file
      // byte-for-byte and any drift produces "corrupt patch at line
      // N" or "patch does not apply". Real LLM output drifts on
      // ~10-30% of attempts even with a tight prompt (validated
      // empirically against this codebase's YAML / Markdown /
      // typescript edits). The framework treats that as routine and
      // retries with a self-correction prompt, mirroring how a human
      // engineer would react to `git apply` rejection: read the
      // error, look at the diff, fix it.
      //
      // Failure mode the loop retries today:
      //   - apply-branch/diff-apply-failed (LLM diff quality;
      //     ~10-30% empirical drift rate even with a tight prompt)
      // Non-retryable: every drafter error (including transient
      // llm-call-failed; the catch on DrafterError returns
      // immediately), dirty-worktree, fetch-failed, push-failed,
      // pr-creation/* -- those are environment / auth issues that
      // persist across retries. If transient LLM failures should
      // self-heal in a future iteration, the catch on DrafterError
      // needs to fall through (with attempt-bound + backoff); the
      // current single-shot behaviour for llm-call-failed is the
      // committed contract.
      const MAX_DRAFT_ATTEMPTS = maxDraftAttempts;
      let draftResult;
      let gitResult;
      let branchName: string | undefined;
      let lastApplyError: string | null = null;
      let lastDraftDiff: string | null = null;
      let attempt = 0;
      while (attempt < MAX_DRAFT_ATTEMPTS) {
        attempt += 1;
        // Fresh nonce -> fresh branch name per attempt; see comment
        // above.
        branchName = `${branchPrefix}${safeIdForRef}-${nonce()}`;
        const augmentedQuestionPrompt = buildSelfCorrectingPrompt({
          base: questionPrompt,
          previousDiff: lastDraftDiff,
          previousError: lastApplyError,
        });
        try {
          draftResult = await draftCodeChange(config.host, {
            plan,
            fence,
            targetPaths,
            model: config.model,
            ...(successCriteria !== undefined ? { successCriteria } : {}),
            ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
            ...(signal !== undefined ? { signal } : {}),
            ...(fileContents.length > 0 ? { fileContents } : {}),
            ...(augmentedQuestionPrompt !== undefined && augmentedQuestionPrompt.length > 0
              ? { questionPrompt: augmentedQuestionPrompt }
              : {}),
          });
        } catch (err) {
          // Drafter errors are not retried (the catch returns
          // immediately); appending the attempt counter would be
          // semantically inconsistent for callers reading
          // result.reason. The attempt loop only retries on
          // diff-apply failures (the GitOpsError branch below).
          if (err instanceof DrafterError) {
            return {
              kind: 'error',
              stage: `drafter/${err.reason}`,
              reason: err.message,
            };
          }
          return {
            kind: 'error',
            stage: 'drafter/unexpected',
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        // Verify each path the drafter declared in `cited_paths`
        // exists on the working tree before opening the PR. The
        // drafter has no read access at draft-time and confabulates
        // plausible-looking paths from the plan body when not given
        // the actual files; this gate catches the resulting
        // hallucinations before they ship as PR-body or in-diff
        // prose. Verification is path-traversal-safe: every entry
        // is resolved against repoDir and rejected if it escapes.
        // Empty `cited_paths` is the back-compat path (drafter
        // declared no citations) and skips the gate.
        const citationVerifyResult = await verifyCitedPaths(
          draftResult.citedPaths,
          repoDirArg,
        );
        if (citationVerifyResult.kind === 'error') {
          return {
            kind: 'error',
            stage: 'drafter/cited-path-not-found',
            reason: citationVerifyResult.message,
          };
        }

        try {
          gitResult = await applyDraftBranch({
            diff: draftResult.diff,
            repoDir: repoDirArg,
            branchName,
            baseBranch,
            commitMessage: buildCommitMessage(plan, draftResult.notes),
            authorIdentity: config.gitIdentity,
            stagePaths: draftResult.touchedPaths,
            remote,
            ...(signal !== undefined ? { signal } : {}),
            ...(config.execImpl !== undefined ? { execImpl: config.execImpl } : {}),
          });
          // Apply succeeded; break out of the retry loop and
          // continue to PR creation.
          break;
        } catch (err) {
          if (err instanceof GitOpsError) {
            // Only re-attempt the drafter when the failure is a
            // diff-quality issue. Environment-level failures
            // (dirty worktree, fetch denied, push rejected) won't
            // change between attempts and re-running the LLM
            // wastes tokens.
            const isDiffQualityError = err.reason === 'diff-apply-failed';
            if (!isDiffQualityError || attempt >= MAX_DRAFT_ATTEMPTS) {
              return {
                kind: 'error',
                stage: `apply-branch/${err.reason}`,
                reason: `${err.message} (stage=${err.stage}, attempt ${attempt}/${MAX_DRAFT_ATTEMPTS})`,
              };
            }
            // Capture the failure shape so the next drafter call
            // can self-correct with the diff git rejected + the
            // exact rejection reason.
            lastApplyError = `${err.message} (stage=${err.stage})`;
            lastDraftDiff = draftResult.diff;
            continue;
          }
          return {
            kind: 'error',
            stage: 'apply-branch/unexpected',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }

      if (gitResult === undefined || draftResult === undefined) {
        // Unreachable under normal flow: the loop either breaks on
        // success or returns an error. This guard exists so the
        // type checker proves both are defined for the createDraftPr
        // call below; if it ever fires, it is a true bug.
        return {
          kind: 'error',
          stage: 'apply-branch/unexpected',
          reason: 'drafter retry loop exited without a result and without a typed error',
        };
      }

      // Embed plan + provenance ancestor atom snapshots in the
      // body so a downstream consumer that cannot reach this
      // host's atom store can still resolve the atoms via the
      // carrier the dispatch wrote into the PR. The default
      // ancestor type (`operator-intent`) matches the substrate's
      // intent-driven-plan vocabulary; deployments that key their
      // audit chain on a different ancestor pass an alternate
      // type through buildEmbeddedAtomSnapshots.
      const embeddedAtoms = await buildEmbeddedAtomSnapshots(config.host, plan);
      let prResult;
      try {
        prResult = await createDraftPr({
          client: config.ghClient,
          owner: config.owner,
          repo: config.repo,
          title: buildPrTitle(plan),
          head: gitResult.branchName,
          base: baseBranch,
          body: renderPrBody({
            planId,
            planContent: String(plan.content),
            draftNotes: draftResult.notes,
            draftConfidence: draftResult.confidence,
            observationAtomId: String(inputs.observationAtomId),
            commitSha: gitResult.commitSha,
            costUsd: draftResult.totalCostUsd,
            modelUsed: draftResult.modelUsed,
            touchedPaths: draftResult.touchedPaths,
            embeddedAtoms,
          }),
          draft,
        });
      } catch (err) {
        if (err instanceof PrCreationError) {
          return {
            kind: 'error',
            stage: `pr-creation/${err.reason}`,
            reason: `${err.message} (stage=${err.stage})`,
          };
        }
        return {
          kind: 'error',
          stage: 'pr-creation/unexpected',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      // correlationId is currently unused inside the chain; the invoker
      // records it on the observation atom. Preserved in scope to keep
      // the interface contract stable as future chain steps (e.g., a
      // `code-author-started` atom before the drafter call) begin to
      // consume it.
      void correlationId;

      return {
        kind: 'dispatched',
        prNumber: prResult.number,
        prHtmlUrl: prResult.htmlUrl,
        branchName: gitResult.branchName,
        commitSha: gitResult.commitSha,
        totalCostUsd: draftResult.totalCostUsd,
        modelUsed: draftResult.modelUsed,
        confidence: draftResult.confidence,
        touchedPaths: draftResult.touchedPaths,
      };
  }
}

/**
 * Compose the drafter's `questionPrompt` for one attempt. On the
 * first attempt (no previous diff/error) returns the operator's
 * original prompt unchanged; on retries appends a structured
 * SELF-CORRECTION block telling the LLM what its prior diff was
 * and exactly what `git apply` rejected. This is the one place
 * the framework leans on the LLM to fix its own output -- the
 * prompt is precise enough that a competent LLM converges within
 * the default 3 attempts on real diff-drift cases.
 *
 * Exported for unit tests; the wider executor uses it inline.
 */
export function buildSelfCorrectingPrompt({
  base,
  previousDiff,
  previousError,
}: {
  readonly base: string | undefined;
  readonly previousDiff: string | null;
  readonly previousError: string | null;
}): string | undefined {
  if (previousDiff === null && previousError === null) {
    return base;
  }
  const sections: string[] = [];
  if (typeof base === 'string' && base.length > 0) {
    sections.push('ORIGINAL_REQUEST:');
    sections.push(base);
    sections.push('');
  }
  sections.push('PREVIOUS_ATTEMPT_REJECTED_BY_GIT_APPLY:');
  sections.push(previousError ?? '(no error captured)');
  sections.push('');
  sections.push('PREVIOUS_DIFF (verbatim, do not repeat):');
  sections.push('```diff');
  sections.push(previousDiff ?? '(no diff captured)');
  sections.push('```');
  sections.push('');
  sections.push(
    'Produce a CORRECTED unified diff. Pay close attention to: '
    + '(1) the `@@ -X,Y +A,B @@` hunk header line counts must EXACTLY match the file content shown in file_contents; '
    + '(2) every context line must match the source byte-for-byte (whitespace, indentation, trailing characters); '
    + '(3) no BOM, no stray invisible characters; '
    + '(4) line endings consistent with the source file. '
    + 'If you are uncertain about line counts, prefer a smaller, tighter hunk over a larger speculative one.',
  );
  return sections.join('\n');
}

/**
 * Verify each entry in `citedPaths` exists on the working tree
 * rooted at `repoDir`. Returns `{ kind: 'ok' }` when every entry
 * is present, or `{ kind: 'error', message }` on the first failure.
 *
 * Path-traversal safety: each entry is resolved against `repoDir`
 * via `resolve` and rejected when the resolved absolute path is
 * not contained in `repoDir`. An adversarial citation that climbs
 * out of the worktree (e.g. `../../etc/passwd`) is treated the
 * same as a missing path.
 *
 * Trailing-separator entries (`src/runtime/actors/planning/`) are
 * directory citations; the `access` check tolerates either file
 * or directory. The check uses fs.access in default mode, which
 * verifies existence without requiring read permission.
 *
 * Empty `citedPaths` is the back-compat path: drafter declared no
 * citations, nothing to verify, return ok.
 */
export async function verifyCitedPaths(
  citedPaths: ReadonlyArray<string>,
  repoDir: string,
): Promise<{ kind: 'ok' } | { kind: 'error'; message: string }> {
  if (citedPaths.length === 0) return { kind: 'ok' };
  const repoRoot = resolve(repoDir);
  const repoRootWithSep = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
  for (const cited of citedPaths) {
    if (typeof cited !== 'string' || cited.length === 0) {
      return {
        kind: 'error',
        message: `cited_paths entry is not a non-empty string: ${JSON.stringify(cited)}`,
      };
    }
    if (isAbsolute(cited)) {
      return {
        kind: 'error',
        message: `cited_paths entry must be repository-relative; got absolute path ${JSON.stringify(cited)}`,
      };
    }
    const resolved = resolve(repoRoot, cited);
    if (resolved !== repoRoot && !resolved.startsWith(repoRootWithSep)) {
      return {
        kind: 'error',
        message: `cited_paths entry escapes the repository root: ${JSON.stringify(cited)}`,
      };
    }
    try {
      await access(resolved);
    } catch {
      return {
        kind: 'error',
        message: `cited_paths entry does not exist on the working tree: ${JSON.stringify(cited)}`,
      };
    }
  }
  return { kind: 'ok' };
}

function extractStringArray(
  meta: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> {
  const v = meta[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function buildPrTitle(plan: Atom): string {
  const meta = plan.metadata as Record<string, unknown>;
  const title = typeof meta['title'] === 'string' && meta['title'].length > 0
    ? meta['title']
    : `plan ${plan.id}`;
  return `code-author: ${title}`;
}

function buildCommitMessage(plan: Atom, draftNotes: string): string {
  const title = buildPrTitle(plan);
  const body = draftNotes.trim();
  return body.length > 0 ? `${title}\n\n${body}` : title;
}

/**
 * Heuristic path extractor over prose plan content. Looks for
 * `<dir>/<file>.<ext>` shapes where `<ext>` is a known text or code
 * extension. Intended as a FALLBACK when plan.metadata.target_paths
 * is unset -- a structured field is always preferred. The extension
 * allowlist is deliberately narrow so prose like `example.com` or
 * `1.2.3` does not get misread as a file path.
 *
 * The returned list is de-duplicated and order-stable to the first
 * occurrence in the prose (for deterministic DATA-hash behavior in
 * tests that depend on the drafter call fingerprint).
 */
function extractTargetPathsFromProse(prose: string): string[] {
  // Extension allowlist -- text/code files we expect the Code Author
  // to touch. Deliberately excludes extensions that show up in prose
  // for other reasons (e.g., `.com`, `.org`, `.net`, version strings).
  const extAllowlist = 'md|ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|css|scss|html|sh|py|go|rs|java|kt|rb|ex|exs';
  // The leading lookbehind `(?<![A-Za-z0-9_\\/.])` blocks matches
  // that begin adjacent to a word char, `/`, or `.` -- i.e., the
  // match must start fresh at a true prose boundary (whitespace,
  // punctuation other than `/.`, start-of-string). This is what
  // keeps a traversal-attempt like `../../etc/passwd.md` from
  // matching any of its inner fragments (`etc/...`, `tc/...`,
  // `passwd.md`'s leaf, etc.) -- every starting position inside
  // the escape token is preceded by a blocked char.
  // First segment cannot start with a `.` (excludes `./foo.md`) but
  // may contain `.` so dotted top-level filenames (`my.config.yml`,
  // `tsconfig.json`, `README.md`) match. Path segments are
  // zero-or-more so a top-level filename in prose ("update README.md")
  // is recognized; the prior `+` quantifier required at least one `/`
  // and silently dropped top-level paths. Together with the per-
  // segment `..` / `.` guard below and the reader sandbox check, this
  // is three independent lines of defense against a plan whose prose
  // tries to exfiltrate or write outside repoDir.
  const pathRe = new RegExp(
    `(?<![A-Za-z0-9_\\/.])([A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\\/[A-Za-z0-9_.-]+)*\\.(?:${extAllowlist}))\\b`,
    'g',
  );
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(prose)) !== null) {
    // Normalize unified-diff path prefixes. When plan content itself
    // embeds a diff, the heuristic would otherwise emit `a/foo.md`
    // AND `b/foo.md` as distinct targets; the drafter then produces
    // a diff touching the bare `foo.md`, and the downstream path-
    // scope check fails because the bare path is not in the
    // inflated target set. Folding `a/` and `b/` to the bare path
    // mirrors git semantics.
    const p = stripDiffPathPrefix(m[1]!);
    if (hasTraversalSegment(p)) continue;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function stripDiffPathPrefix(p: string): string {
  // Only fold when stripping the `a/` or `b/` prefix still leaves a
  // `<dir>/<file>` shape. This keeps a legitimate top-level directory
  // named `a` or `b` (e.g., `a/index.md`) from being collapsed to a
  // leaf-only path that the drafter would then reject under a
  // different invariant.
  const isDiffPrefix = p.startsWith('a/') || p.startsWith('b/');
  if (!isDiffPrefix) return p;
  const stripped = p.slice(2);
  return stripped.includes('/') ? stripped : p;
}

function hasTraversalSegment(p: string): boolean {
  for (const seg of p.split('/')) {
    if (seg === '..' || seg === '.') return true;
  }
  return false;
}

/**
 * Pre-read target files from the repo into `{ path, content }`
 * tuples. An ENOENT (or ENOTDIR) is the expected CREATE case:
 * the path will exist after the diff is applied but does not yet.
 * Silently skip those entries; the drafter's system prompt tells
 * the LLM to emit `--- /dev/null` for any path that appears in
 * `target_paths` but not in `file_contents`.
 *
 * Any other fs error (EACCES, EISDIR, etc.) propagates so the
 * executor surfaces it at the drafter stage rather than pretending
 * the path was fine.
 */
async function readTargetContents(
  paths: ReadonlyArray<string>,
  repoDir: string,
  readFn: (absolutePath: string) => Promise<string>,
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const repoAbs = resolve(repoDir);
  // Normalize the boundary marker so substring matching does not
  // accept a sibling directory whose name extends repoDir (e.g.,
  // `/repo` vs `/repo-escape`). Appending the platform separator
  // ensures only paths INSIDE repoDir are accepted; the exact
  // repoDir root itself is rejected (we always read files, never
  // the directory as a file).
  const repoAbsWithSep = repoAbs.endsWith(sep) ? repoAbs : `${repoAbs}${sep}`;
  for (const p of paths) {
    // Defense in depth: even if target_paths was pre-filtered, the
    // reader re-verifies the resolved absolute path stays strictly
    // inside repoDir. This catches:
    //   - absolute paths (`/etc/passwd.md`) supplied via metadata
    //     that bypass the heuristic's `..` check
    //   - relative paths whose `..` segments resolve out of repo
    //     (`../escape.md` -> parent-of-repoDir)
    //   - Windows drive-letter absolutes (`C:\\Windows\\...`) on
    //     a POSIX-rooted repo
    // Any path that does not resolve inside repoDir is SKIPPED:
    // the drafter then sees no file_contents entry for it, so the
    // LLM will treat it as a CREATE. If it was a legitimate create
    // the diff still lands; if it was an escape attempt the LLM's
    // diff would target the declared path (inside scope), and the
    // executor's downstream path-scope check + git apply would
    // reject any attempt to stage paths outside the repo tree.
    //
    // Symlink trust assumption: the lexical `resolve()` does NOT
    // follow symlinks. A symlink whose target points outside repoDir
    // (e.g., `repoDir/link-to-etc/passwd.md` -> `/etc/passwd.md`)
    // would pass this boundary check. The executor accepts that
    // surface because repoDir is operator-controlled in every
    // supported deployment shape: the diff-based path operates on
    // the operator's checked-out repo, and the agentic path runs
    // against a `WorkspaceProvider`-acquired worktree provisioned
    // by trusted infrastructure. If untrusted plan content can land
    // symlinks into the repo *before* execute() runs, multiple
    // other invariants break (git pre-commit hooks, CI, branch
    // protection); a symlink check here would not close the actual
    // hole. A hardened deployment that wants `realpath`-based
    // checking layers it at the workspace boundary instead.
    const candidateAbs = isAbsolute(p) ? p : join(repoDir, p);
    const resolvedAbs = resolve(candidateAbs);
    if (!resolvedAbs.startsWith(repoAbsWithSep)) {
      continue; // sandbox escape -> silently skip (treated as CREATE)
    }
    try {
      const content = await readFn(resolvedAbs);
      out.push({ path: p, content });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw err;
    }
  }
  return out;
}

function sanitizeGitRefComponent(s: string): string {
  // Single-pass linear sanitizer (no regex). Allowed chars
  // [A-Za-z0-9._/] are kept verbatim; '-' and any disallowed char
  // collapse into a single '-'. Length-bounded to 120. Final trim of
  // leading/trailing '.', '-', '/' keeps git-ref-illegal shapes
  // (`.lock`, `-`, `./..`) out of the output.
  //
  // This is provably linear in the input length. The previous
  // regex-based form (`/^[.\-/]+|[.\-/]+$/g` with `/-+/g`) tripped
  // CodeQL's polynomial-redos heuristic on adversarial dash-runs.
  if (s.length === 0) return 'unnamed';
  const buf: string[] = [];
  let prevDash = false;
  for (let i = 0; i < s.length && buf.length < 120; i++) {
    const ch = s.charCodeAt(i);
    const isAlpha = (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a);
    const isDigit = ch >= 0x30 && ch <= 0x39;
    const isDot = ch === 0x2e;
    const isUnderscore = ch === 0x5f;
    const isSlash = ch === 0x2f;
    if (isAlpha || isDigit || isDot || isUnderscore || isSlash) {
      buf.push(s[i]!);
      prevDash = false;
    } else if (!prevDash) {
      buf.push('-');
      prevDash = true;
    }
  }
  let start = 0;
  let end = buf.length;
  while (start < end && (buf[start] === '.' || buf[start] === '-' || buf[start] === '/')) start++;
  while (end > start && (buf[end - 1] === '.' || buf[end - 1] === '-' || buf[end - 1] === '/')) end--;
  return start < end ? buf.slice(start, end).join('') : 'unnamed';
}
