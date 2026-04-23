/**
 * Default CodeAuthorExecutor: composes drafter + git-ops + pr-creation
 * into a single execute() call.
 *
 * This is the concrete implementation an on-premise consumer plugs in.
 * A different consumer (LangGraph-orchestrated, Temporal workflow, etc.)
 * can implement CodeAuthorExecutor against the same invoker without
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
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { execa } from 'execa';
import type { Atom } from '../../types.js';
import type { Host } from '../../interface.js';
import type { GhClient } from '../../external/github/index.js';
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
  createDraftPr,
  renderPrBody,
  PrCreationError,
} from '../actors/code-author/pr-creation.js';
import type {
  CodeAuthorExecutor,
  CodeAuthorExecutorResult,
} from './code-author-invoker.js';

export interface DefaultExecutorConfig {
  readonly host: Host;
  readonly ghClient: GhClient;
  readonly owner: string;
  readonly repo: string;
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
}

export function buildDefaultCodeAuthorExecutor(
  config: DefaultExecutorConfig,
): CodeAuthorExecutor {
  const branchPrefix = config.branchPrefix ?? 'code-author/';
  const baseBranch = config.baseBranch ?? 'main';
  const remote = config.remote ?? 'origin';
  const draft = config.draft ?? true;
  const nonce = config.nonce ?? (() => randomBytes(3).toString('hex'));

  return {
    async execute(inputs): Promise<CodeAuthorExecutorResult> {
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
      const branchName = `${branchPrefix}${safeIdForRef}-${nonce()}`;
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
      const fileContents = await readTargetContents(targetPaths, config.repoDir, readFn);

      let draftResult;
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
          ...(questionPrompt !== undefined && questionPrompt.length > 0
            ? { questionPrompt }
            : {}),
        });
      } catch (err) {
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

      let gitResult;
      try {
        gitResult = await applyDraftBranch({
          diff: draftResult.diff,
          repoDir: config.repoDir,
          branchName,
          baseBranch,
          commitMessage: buildCommitMessage(plan, draftResult.notes),
          authorIdentity: config.gitIdentity,
          stagePaths: draftResult.touchedPaths,
          remote,
          ...(signal !== undefined ? { signal } : {}),
          ...(config.execImpl !== undefined ? { execImpl: config.execImpl } : {}),
        });
      } catch (err) {
        if (err instanceof GitOpsError) {
          return {
            kind: 'error',
            stage: `apply-branch/${err.reason}`,
            reason: `${err.message} (stage=${err.stage})`,
          };
        }
        return {
          kind: 'error',
          stage: 'apply-branch/unexpected',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

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
    },
  };
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
  // First segment cannot start with a `.` (excludes `./foo.md`).
  // Subsequent segments allow `.` so filenames with dots
  // (`my.config.yml`) keep working. Together with the per-segment
  // `..` / `.` guard below and the reader sandbox check, this is
  // three independent lines of defense against a plan whose prose
  // tries to exfiltrate or write outside repoDir.
  const pathRe = new RegExp(
    `(?<![A-Za-z0-9_\\/.])([A-Za-z0-9_-][A-Za-z0-9_-]*(?:\\/[A-Za-z0-9_.-]+)+\\.(?:${extAllowlist}))\\b`,
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
  // Keep ASCII letters, digits, dot, underscore, slash, dash.
  // Replace anything else with '-'. Collapse repeat dashes so a
  // pathological id does not produce a `---` run. Trim leading and
  // trailing dashes + dots so we never produce `.lock`, `-`, `./..`
  // shapes that git rejects.
  return s
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-/]+|[.\-/]+$/g, '')
    .slice(0, 120) || 'unnamed';
}
